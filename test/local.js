'use strict';
// Test Phase 4 (chỉ trên Windows): terminal local qua node-pty, chặn tính năng local khi đi qua proxy/tắt bằng env,
// RDP (chế độ dry-run: kiểm tra file .rdp, giải mã ngược blob DPAPI), tạo SSH key, cài key lên server và đăng nhập bằng key.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { tmpDir, startProc, client, suite } = require('./helpers');
const { POWERSHELL, powerShellEnv } = require('../lib/windows-powershell');

if (process.platform !== 'win32') {
  console.log('Bỏ qua test local (chỉ chạy trên Windows).');
  process.exit(0);
}

const WT_PORT = 3394;
const WT_NOLOCAL_PORT = 3393;
const SSH_PORT = 2294;
const TOKEN = 'test-token-local';
const TMP = tmpDir('webterm-local-');
const SSH_DIR = path.join(TMP, 'dotssh');
const t = suite('Local: terminal local, RDP, SSH key');
const c = client({ port: WT_PORT, token: TOKEN });
const cNo = client({ port: WT_NOLOCAL_PORT, token: TOKEN });

t.onCleanup(() => fs.rmSync(TMP, { recursive: true, force: true }));

function dpapiDecrypt(hex) {
  const r = spawnSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-Command', '-'],
    { input: `$s = ConvertTo-SecureString '${hex}'\n$p = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))\n[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p))\n`, encoding: 'utf8', env: powerShellEnv(), windowsHide: true }
  );
  assert.strictEqual(r.status, 0, `Giải mã DPAPI lỗi: ${r.stderr}`);
  return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
}

t.run(async () => {
  await startProc('test/fake-sshd.js', { FAKE_SSHD_PORT: SSH_PORT, FAKE_SSHD_ROOT: path.join(TMP, 'sshd') });
  await startProc('server.js', { PORT: WT_PORT, WEBTERM_TOKEN: TOKEN, WEBTERM_DATA: path.join(TMP, 'data'), WEBTERM_RDP_DRYRUN: '1', WEBTERM_SSH_DIR: SSH_DIR });

  await t.step('Danh sách shell trên máy: có PowerShell và CMD', async () => {
    const r = await c.authed('GET', '/api/shells');
    assert.strictEqual(r.status, 200);
    const ids = r.json.map((s) => s.id);
    assert.ok(ids.includes('powershell') && ids.includes('cmd'), ids.join(','));
    assert.ok(r.json.every((s) => !('file' in s)), 'không lộ đường dẫn file ra giao diện');
  });

  await t.step('Terminal local (CMD qua ConPTY): chạy lệnh, đổi kích thước, đóng', async () => {
    const term = await c.openTerminal({ kind: 'local', shell: 'cmd', cols: 100, rows: 30 });
    const ready = await term.waitMsg('ready', 10000);
    assert.strictEqual(ready.kind, 'local');
    term.control({ type: 'resize', cols: 120, rows: 40 });
    term.send('echo local-%COMPUTERNAME:~0,0%ok\r');
    await term.waitFor(() => /local-ok/.test(term.output), 'output của cmd', 10000);
    term.send('exit\r');
    await term.waitMsg('closed', 10000);
  });

  await t.step('Tính năng local bị chặn khi request đi qua proxy hoặc khi tắt bằng WEBTERM_LOCAL=0', async () => {
    const proxied = await c.openTerminal({ kind: 'local', shell: 'cmd' }, { headers: { Cookie: c.cookie, Origin: c.origin, 'X-Forwarded-For': '203.0.113.7' } });
    assert.strictEqual((await proxied.waitMsg('error')).code, 'local-only');
    assert.strictEqual((await c.authed('GET', '/api/shells', { headers: { 'X-Forwarded-For': '203.0.113.7' } })).status, 403);
    await startProc('server.js', { PORT: WT_NOLOCAL_PORT, WEBTERM_TOKEN: TOKEN, WEBTERM_DATA: path.join(TMP, 'data2'), WEBTERM_LOCAL: '0' });
    assert.strictEqual((await cNo.authed('GET', '/api/capabilities')).json.localFeatures, false);
    assert.strictEqual((await cNo.authed('GET', '/api/shells')).status, 403);
    const term = await cNo.openTerminal({ kind: 'local', shell: 'cmd' });
    assert.strictEqual((await term.waitMsg('error')).code, 'local-only');
  });

  await t.step('RDP: file .rdp đúng, mật khẩu mã hoá DPAPI giải mã lại đúng, không chèn được dòng lạ', async () => {
    const s = await c.authed('POST', '/api/sessions', {
      body: { type: 'rdp', name: 'Win VPS', host: '10.1.2.3', port: 3390, username: 'Admin\r\nalternate shell:s:cmd.exe', password: 'Mật-khẩu#123', rdpFullscreen: true },
    });
    const r = await c.authed('POST', `/api/rdp/${s.json.id}/launch`, { body: {} });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.mode, 'dpapi');
    const lines = r.json.rdp.split('\r\n');
    assert.ok(lines.includes('full address:s:10.1.2.3:3390'));
    assert.ok(lines.includes('screen mode id:i:2'));
    assert.ok(lines.includes('prompt for credentials:i:0'));
    assert.ok(!lines.some((l) => l.startsWith('alternate shell')), 'không chèn được thiết lập qua username');
    assert.ok(lines.includes(`password 51:b:${r.json.blob}`));
    assert.strictEqual(dpapiDecrypt(r.json.blob), 'Mật-khẩu#123');
  });

  await t.step('RDP: không có mật khẩu thì để Windows hỏi; mật khẩu nhập lúc mở được dùng', async () => {
    const s = await c.authed('POST', '/api/sessions', { body: { type: 'rdp', name: 'Không mật khẩu', host: '10.1.2.4', username: 'u' } });
    const r = await c.authed('POST', `/api/rdp/${s.json.id}/launch`, { body: {} });
    assert.strictEqual(r.json.mode, 'prompt');
    assert.ok(!r.json.rdp.includes('password 51:b:'));
    const r2 = await c.authed('POST', `/api/rdp/${s.json.id}/launch`, { body: { password: 'nhap-luc-mo' } });
    assert.strictEqual(r2.json.mode, 'dpapi');
    assert.strictEqual(dpapiDecrypt(r2.json.blob), 'nhap-luc-mo');
  });

  let ed;
  await t.step('Tạo key ed25519 có passphrase: lưu vào ~/.ssh, không ghi đè file đã có', async () => {
    const r = await c.authed('POST', '/api/keygen', { body: { type: 'ed25519', comment: 'webterm test', passphrase: 'pp-123', name: 'id_webterm_test', save: true } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    ed = r.json;
    assert.match(ed.publicKey, /^ssh-ed25519 \S+ webterm test$/);
    assert.match(ed.fingerprint, /^SHA256:/);
    assert.strictEqual(fs.readFileSync(path.join(SSH_DIR, 'id_webterm_test'), 'utf8'), ed.privateKey);
    const body = Buffer.from(ed.privateKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
    assert.ok(body.includes(Buffer.from('aes256-ctr')), 'private key được mã hoá bằng passphrase');
    const again = await c.authed('POST', '/api/keygen', { body: { type: 'ed25519', name: 'id_webterm_test', save: true } });
    assert.strictEqual(again.status, 409);
    assert.strictEqual((await c.authed('POST', '/api/keygen', { body: { type: 'dsa' } })).status, 400);
  });

  await t.step('Chép key lên server (ssh-copy-id), lần 2 báo đã có, rồi đăng nhập bằng key + passphrase', async () => {
    const pw = await c.authed('POST', '/api/sessions', { body: { name: 'Mật khẩu', host: '127.0.0.1', port: SSH_PORT, username: 'test', password: 'secret' } });
    const term = await c.openTerminal({ sessionId: pw.json.id });
    const ready = await term.waitMsg('ready');
    const first = await c.authed('POST', `/api/sftp/${ready.id}/install-key`, { body: { publicKey: ed.publicKey } });
    assert.deepStrictEqual(first.json, { status: 'installed', via: 'shell' });
    const second = await c.authed('POST', `/api/sftp/${ready.id}/install-key`, { body: { publicKey: ed.publicKey } });
    assert.strictEqual(second.json.status, 'exists');
    assert.strictEqual((await c.authed('POST', `/api/sftp/${ready.id}/install-key`, { body: { publicKey: 'ssh-ed25519 AAAA\nrm -rf /' } })).status, 400);
    await term.close();
    const keyed = await c.authed('POST', '/api/sessions', {
      body: { name: 'Bằng key', host: '127.0.0.1', port: SSH_PORT, username: 'test', auth: 'key', privateKeyPath: path.join(SSH_DIR, 'id_webterm_test'), passphrase: 'pp-123' },
    });
    const kt = await c.openTerminal({ sessionId: keyed.json.id });
    await kt.waitMsg('ready');
    kt.send('whoami\r');
    await kt.waitFor(() => /whoami\r\ntest\r\n/.test(kt.output), 'đăng nhập bằng key');
    await kt.close();
  });

  await t.step('Key RSA 4096: tạo bất đồng bộ, cài lên server, đăng nhập được (chữ ký rsa-sha2)', async () => {
    const r = await c.authed('POST', '/api/keygen', { body: { type: 'rsa', name: 'id_rsa_test', save: true } });
    assert.match(r.json.publicKey, /^ssh-rsa /);
    const pw = (await c.authed('GET', '/api/sessions')).json.find((s) => s.name === 'Mật khẩu');
    const term = await c.openTerminal({ sessionId: pw.id });
    const ready = await term.waitMsg('ready');
    await c.authed('POST', `/api/sftp/${ready.id}/install-key`, { body: { publicKey: r.json.publicKey } });
    await term.close();
    const keyed = await c.authed('POST', '/api/sessions', { body: { name: 'RSA', host: '127.0.0.1', port: SSH_PORT, username: 'test', auth: 'key', privateKeyPath: path.join(SSH_DIR, 'id_rsa_test') } });
    const kt = await c.openTerminal({ sessionId: keyed.json.id });
    await kt.waitMsg('ready');
    await kt.close();
  });

  await t.step('Session chỉ ghi tên file key (kiểu chạy từ USB): tính từ thư mục key, đăng nhập được', async () => {
    const rel = await c.authed('POST', '/api/sessions', { body: { name: 'Key tương đối', host: '127.0.0.1', port: SSH_PORT, username: 'test', auth: 'key', privateKeyPath: 'id_rsa_test' } });
    const kt = await c.openTerminal({ sessionId: rel.json.id });
    await kt.waitMsg('ready');
    await kt.close();
    const missing = await c.authed('POST', '/api/sessions', { body: { name: 'Thiếu key', host: '127.0.0.1', port: SSH_PORT, username: 'test', auth: 'key', privateKeyPath: 'khong_co_key' } });
    const mt = await c.openTerminal({ sessionId: missing.json.id });
    const err = await mt.waitMsg('error');
    assert.ok(err.message.includes(path.join(SSH_DIR, 'khong_co_key')), err.message);
    await mt.close();
  });
});
