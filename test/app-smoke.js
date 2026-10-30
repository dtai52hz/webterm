'use strict';
// Test app desktop: chạy fake-sshd, mở app ở chế độ --smoke (cửa sổ ẩn, dữ liệu tạm),
// kiểm tra giao diện nạp được, API có cookie và SSH thật sự chạy bên trong Electron.
// Chạy:   npm run test:app                      (bản dev, dùng electron trong node_modules)
//         node test/app-smoke.js dist\win-unpacked\WebTerm.exe   (bản đã đóng gói)
// Thêm --portable để thử chạy từ USB: dữ liệu phải nằm trong WebTerm-data cạnh file .exe
// (bản Portable được chép sang một thư mục tạm đóng vai USB).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SSH_PORT = 2298;
const root = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const PORTABLE = argv.includes('--portable');
const exeArg = argv.find((a) => !a.startsWith('--'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-app-test-'));
const outFile = path.join(tmp, 'smoke.json');
const usbDir = path.join(tmp, 'usb');

let exe = exeArg ? path.resolve(exeArg) : require('electron');
const args = exeArg ? ['--smoke'] : [root, '--smoke'];
const env = { ...process.env, WEBTERM_SMOKE_SSH: `127.0.0.1:${SSH_PORT}`, WEBTERM_SMOKE_OUT: outFile };
delete env.ELECTRON_RUN_AS_NODE;
if (PORTABLE) {
  env.WEBTERM_SMOKE_PORTABLE = '1';
  fs.mkdirSync(usbDir);
  if (/portable/i.test(path.basename(exe))) {
    // Launcher của bản Portable tự đặt PORTABLE_EXECUTABLE_DIR theo nơi chứa file .exe.
    const copy = path.join(usbDir, path.basename(exe));
    fs.copyFileSync(exe, copy);
    exe = copy;
  } else {
    env.PORTABLE_EXECUTABLE_DIR = usbDir;
  }
}

function checkPortable(result) {
  const dataRoot = path.join(usbDir, 'WebTerm-data');
  const problems = [];
  const dir = result && result.portable && result.portable.dir;
  if (!dir || path.resolve(dir).toLowerCase() !== dataRoot.toLowerCase()) problems.push(`capabilities.portable.dir = ${dir}`);
  if (!fs.existsSync(path.join(dataRoot, 'data', 'known_hosts.json'))) problems.push('thiếu data\\known_hosts.json trên "USB"');
  if (!fs.existsSync(path.join(dataRoot, 'browser'))) problems.push('dữ liệu cửa sổ (browser) không nằm trên "USB"');
  return problems;
}

const sshd = spawn(process.execPath, [path.join(__dirname, 'fake-sshd.js')], {
  env: { ...process.env, FAKE_SSHD_PORT: SSH_PORT, FAKE_SSHD_ROOT: path.join(tmp, 'sshd') },
  stdio: ['ignore', 'pipe', 'inherit'],
});

sshd.stdout.once('data', () => {
  const app = spawn(exe, args, { env, stdio: 'ignore' });
  app.on('exit', (code) => {
    sshd.kill();
    let result = null;
    try {
      result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch {}
    const problems = PORTABLE ? checkPortable(result) : [];
    console.log(`App: ${exe}`);
    console.log(`Kết quả: ${JSON.stringify(result)}`);
    for (const p of problems) console.log(`Chạy từ USB: ${p}`);
    const ok = code === 0 && !problems.length;
    console.log(ok ? `App desktop${PORTABLE ? ' (chạy từ USB)' : ''}: ĐẠT` : `App desktop: LỖI (exit ${code})`);
    // Launcher của bản Portable có thể giữ file .exe thêm một lúc sau khi thoát.
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    process.exitCode = ok ? 0 : 1;
  });
});
