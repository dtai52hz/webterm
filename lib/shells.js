'use strict';
// Dò các shell có trên máy (PowerShell, CMD, Git Bash, WSL...). Người dùng chỉ chọn theo id trong danh sách này.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let cache = null;

function findOnPath(exe) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, exe);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

const firstExisting = (paths) => paths.find((p) => p && fs.existsSync(p)) || null;

// `wsl -l -q` in ra UTF-16LE; khi chưa cài distro thì trả mã lỗi.
function wslDistros(sys) {
  const wsl = path.join(sys, 'System32', 'wsl.exe');
  if (!fs.existsSync(wsl)) return [];
  try {
    const r = spawnSync(wsl, ['-l', '-q'], { timeout: 4000, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return [];
    return r.stdout
      .toString('utf16le')
      .split(/\r?\n/)
      .map((s) => s.replace(/\0/g, '').trim())
      .filter((s) => s && /^[\w.\-]+$/.test(s))
      .map((name) => ({ id: `wsl:${name}`, name: `WSL: ${name}`, file: wsl, args: ['-d', name] }));
  } catch {
    return [];
  }
}

function detect() {
  if (process.platform !== 'win32') {
    const sh = process.env.SHELL || '/bin/bash';
    return fs.existsSync(sh) ? [{ id: 'default', name: path.basename(sh), file: sh, args: ['-l'] }] : [];
  }
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const list = [
    { id: 'powershell', name: 'Windows PowerShell', file: path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] },
    { id: 'pwsh', name: 'PowerShell 7', file: findOnPath('pwsh.exe') || firstExisting([path.join(pf, 'PowerShell', '7', 'pwsh.exe')]), args: ['-NoLogo'] },
    { id: 'cmd', name: 'Command Prompt (CMD)', file: process.env.ComSpec || path.join(sys, 'System32', 'cmd.exe'), args: [] },
    {
      id: 'gitbash',
      name: 'Git Bash',
      file: firstExisting([path.join(pf, 'Git', 'bin', 'bash.exe'), path.join(pf86, 'Git', 'bin', 'bash.exe'), path.join(local, 'Programs', 'Git', 'bin', 'bash.exe')]),
      args: ['--login', '-i'],
    },
    ...wslDistros(sys),
  ];
  return list.filter((s) => s.file && fs.existsSync(s.file));
}

function list() {
  if (!cache) cache = detect();
  return cache;
}

const get = (id) => list().find((s) => s.id === id) || null;

// Thông tin công khai cho giao diện (không lộ đường dẫn đầy đủ không cần thiết).
const publicList = () => list().map(({ id, name }) => ({ id, name }));

module.exports = { list, get, publicList };
