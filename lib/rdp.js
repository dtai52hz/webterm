'use strict';
// Mở Remote Desktop (mstsc) cho session kiểu RDP, giống session RDP của MobaXterm.
// Mật khẩu (nếu có) không bao giờ nằm trên dòng lệnh: PowerShell đọc script từ stdin.
//  - dpapi: ghi "password 51:b:<blob DPAPI>" vào file .rdp tạm (chỉ user Windows hiện tại giải mã được)
//  - credman: lưu TERMSRV/<host> vào Windows Credential Manager
//  - prompt: để mstsc tự hỏi
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const vault = require('./vault');
const { cleanEnv } = require('./guard');
const { POWERSHELL, powerShellEnv } = require('./windows-powershell');

const DRYRUN = () => process.env.WEBTERM_RDP_DRYRUN === '1';
const SYS = process.env.SystemRoot || 'C:\\Windows';
const MSTSC = path.join(SYS, 'System32', 'mstsc.exe');

// Chạy script PowerShell qua stdin; trả về stdout.
function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const ps = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { env: powerShellEnv(), windowsHide: true });
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => (out += d));
    ps.stderr.on('data', (d) => (err += d));
    ps.on('error', reject);
    ps.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `PowerShell thoát với mã ${code}`))));
    ps.stdin.end(script + '\n');
  });
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const psString = (s) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s)}'))`;

// Blob DPAPI (CurrentUser) của mật khẩu dạng UTF-16, đúng định dạng mstsc đọc trong "password 51:b:".
async function dpapiBlob(password) {
  const hex = await runPowerShell(`$p = ${psString(password)}\n$s = ConvertTo-SecureString -String $p -AsPlainText -Force\nConvertFrom-SecureString -SecureString $s`);
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error('Không tạo được mật khẩu mã hoá cho RDP');
  return hex;
}

async function credmanWrite(host, user, password) {
  const script = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public class WtCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL c, int flags);
  public static bool Write(string target, string user, string pass) {
    var c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;
    byte[] b = System.Text.Encoding.Unicode.GetBytes(pass);
    c.CredentialBlobSize = b.Length;
    c.CredentialBlob = Marshal.AllocCoTaskMem(b.Length);
    Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
    try { return CredWrite(ref c, 0); } finally { Marshal.FreeCoTaskMem(c.CredentialBlob); }
  }
}
'@
Add-Type -TypeDefinition $sig
if (-not [WtCred]::Write(${psString(`TERMSRV/${host}`)}, ${psString(user)}, ${psString(password)})) { exit 1 }
'ok'`;
  await runPowerShell(script);
}

// Giá trị trong file .rdp không được chứa xuống dòng (tránh chèn thêm thiết lập).
const clean = (v) => String(v ?? '').replace(/[\r\n]/g, '');

function rdpContent(s, { blob } = {}) {
  const addr = s.port && Number(s.port) !== 3389 ? `${s.host}:${s.port}` : s.host;
  const lines = [
    `full address:s:${clean(addr)}`,
    s.username ? `username:s:${clean(s.username)}` : null,
    `screen mode id:i:${s.rdpFullscreen ? 2 : 1}`,
    // Co nội dung theo cửa sổ và cập nhật độ phân giải khi client/server hỗ trợ.
    // Để mstsc chọn kích thước ban đầu và DPI theo màn hình hiện tại.
    'smart sizing:i:1',
    'dynamic resolution:i:1',
    'use multimon:i:0',
    'redirectclipboard:i:1',
    'autoreconnection enabled:i:1',
    'authentication level:i:2',
    'enablecredsspsupport:i:1',
    blob ? `password 51:b:${blob}` : null,
    blob ? 'prompt for credentials:i:0' : null,
  ];
  return lines.filter(Boolean).join('\r\n') + '\r\n';
}

async function launch(session, { password } = {}) {
  if (process.platform !== 'win32') throw Object.assign(new Error('RDP chỉ hỗ trợ trên Windows'), { status: 400 });
  const pass = password || (session.password ? vault.decrypt(session.password) : '');
  const mode = pass ? session.rdpAuth || 'dpapi' : 'prompt';
  let blob = null;
  if (mode === 'dpapi') blob = await dpapiBlob(pass);
  if (mode === 'credman' && !DRYRUN()) await credmanWrite(session.host, session.username || '', pass);
  const content = rdpContent(session, { blob });
  if (DRYRUN()) return { ok: true, mode, dryRun: true, rdp: content, blob };
  const file = path.join(os.tmpdir(), `webterm-${crypto.randomBytes(6).toString('hex')}.rdp`);
  fs.writeFileSync(file, '\ufeff' + content, { encoding: 'utf16le', mode: 0o600 });
  const child = spawn(MSTSC, [file], { detached: true, stdio: 'ignore', env: cleanEnv() });
  child.on('error', () => {});
  child.unref();
  // mstsc đọc file ngay khi khởi động; xoá sau ít giây để không để lại mật khẩu đã mã hoá trên đĩa.
  setTimeout(() => fs.unlink(file, () => {}), 20_000).unref();
  return { ok: true, mode };
}

module.exports = { launch, rdpContent, dpapiBlob, runPowerShell };
