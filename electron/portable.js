'use strict';
// Chạy từ USB (bản Portable): dữ liệu nằm trong thư mục WebTerm-data cạnh file .exe, giống MobaXterm Portable.
const fs = require('fs');
const path = require('path');

const DIR_NAME = 'WebTerm-data';

// Launcher của bản Portable (electron-builder) đặt PORTABLE_EXECUTABLE_DIR = thư mục chứa file .exe.
// Trả { root, firstRun } khi ghi được vào đó; USB bị khoá ghi thì trả { error } để app lưu trên máy như bản cài đặt.
function setup(env = process.env) {
  if (!env.PORTABLE_EXECUTABLE_DIR) return { root: null };
  const root = path.join(env.PORTABLE_EXECUTABLE_DIR, DIR_NAME);
  try {
    const firstRun = !fs.existsSync(path.join(root, 'data'));
    fs.mkdirSync(root, { recursive: true });
    const probe = path.join(root, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return { root, firstRun };
  } catch (e) {
    return { root: null, error: `${root}: ${e.message}` };
  }
}

// Máy này đã từng dùng WebTerm (bản cài đặt hoặc Portable cũ) thì có thể chép dữ liệu sang USB.
function hasData(dataDir) {
  return ['sessions.json', 'macros.json', 'tunnels.json'].some((f) => fs.existsSync(path.join(dataDir, f)));
}

function copyData(fromDir, toDir) {
  fs.cpSync(fromDir, toDir, { recursive: true });
}

module.exports = { DIR_NAME, setup, hasData, copyData };
