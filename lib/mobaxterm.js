'use strict';
// Đọc session SSH từ file MobaXterm.ini. Mật khẩu MobaXterm được mã hoá
// bằng master password riêng nên không import, chỉ lấy host/port/user/key/thư mục.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SSH_TYPE = '0';

function defaultIniPaths() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return [
    path.join(appData, 'MobaXterm', 'MobaXterm.ini'),
    path.join(os.homedir(), 'Documents', 'MobaXterm', 'MobaXterm.ini'),
    'C:\\Program Files (x86)\\Mobatek\\MobaXterm\\MobaXterm.ini',
    'C:\\Program Files\\Mobatek\\MobaXterm\\MobaXterm.ini',
  ];
}

function findIni() {
  return defaultIniPaths().find((p) => fs.existsSync(p)) || null;
}

// MobaXterm thường lưu INI theo bảng mã ANSI; thử UTF-8 trước, lỗi thì dùng latin1.
function readIni(file) {
  const buf = fs.readFileSync(file);
  const utf8 = buf.toString('utf8');
  return utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8;
}

// MobaXterm thay một số ký tự đặc biệt trong tên bằng token.
function decodeName(s) {
  return s
    .replace(/__PIPE__/g, '|')
    .replace(/__DIEZE__/g, '#')
    .replace(/__PERCENT__/g, '%')
    .replace(/__PTVIRG__/g, ';')
    .replace(/__DBLQUO__/g, '"')
    .replace(/__QUOTE__/g, "'")
    .replace(/__EQUAL__/g, '=');
}

function expandPath(p) {
  if (!p) return '';
  return p
    .replace(/_ProfileDir_/gi, os.homedir())
    .replace(/_CurrentDrive_/gi, 'C:')
    .replace(/_AppDataDir_/gi, process.env.APPDATA || '');
}

function parse(text) {
  const sessions = [];
  let inBookmarks = false;
  let folder = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      inBookmarks = /^Bookmarks(_\d+)?$/i.test(section[1]);
      folder = '';
      continue;
    }
    if (!inBookmarks) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'SubRep') {
      folder = decodeName(value).replace(/\\/g, '/');
      continue;
    }
    if (key === 'ImgNum') continue;
    const m = value.match(/^#\d+#(\d+)%(.*)$/);
    if (!m || m[1] !== SSH_TYPE) continue;
    const f = m[2].split('%');
    const host = f[0];
    if (!host) continue;
    // Field 13 là đường dẫn private key (nếu có).
    const keyPath = expandPath(f[13] || '');
    sessions.push({
      name: decodeName(key),
      folder,
      host,
      port: Number(f[1]) || 22,
      username: f[2] || '',
      auth: keyPath && /[\\/]/.test(keyPath) ? 'key' : 'password',
      privateKeyPath: keyPath && /[\\/]/.test(keyPath) ? keyPath : '',
      source: 'mobaxterm',
    });
  }
  return sessions;
}

module.exports = { findIni, readIni, parse };
