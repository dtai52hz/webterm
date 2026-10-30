'use strict';
// Unit test cho chế độ chạy từ USB (electron/portable.js) và cách hiểu đường dẫn SSH key (lib/keypath.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const portable = require('../../electron/portable');
const { resolveKeyPath } = require('../../lib/keypath');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-portable-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('USB: không phải bản Portable thì giữ thư mục dữ liệu của máy', () => {
  assert.deepStrictEqual(portable.setup({}), { root: null });
});

test('USB: lần đầu tạo WebTerm-data cạnh file .exe, lần sau không còn là lần đầu', () => {
  const usb = path.join(tmp, 'usb');
  const first = portable.setup({ PORTABLE_EXECUTABLE_DIR: usb });
  assert.deepStrictEqual(first, { root: path.join(usb, 'WebTerm-data'), firstRun: true });
  assert.deepStrictEqual(fs.readdirSync(first.root), [], 'không sót file thử ghi');
  fs.mkdirSync(path.join(first.root, 'data'));
  assert.strictEqual(portable.setup({ PORTABLE_EXECUTABLE_DIR: usb }).firstRun, false);
});

test('USB: không ghi được thì báo lỗi để app lưu trên máy', () => {
  const file = path.join(tmp, 'khong-phai-thu-muc');
  fs.writeFileSync(file, '');
  const r = portable.setup({ PORTABLE_EXECUTABLE_DIR: file });
  assert.strictEqual(r.root, null);
  assert.match(r.error, /WebTerm-data/);
});

test('USB: nhận ra máy đã có dữ liệu và chép sang được', () => {
  const from = path.join(tmp, 'appdata');
  fs.mkdirSync(path.join(from, 'sub'), { recursive: true });
  assert.strictEqual(portable.hasData(from), false);
  fs.writeFileSync(path.join(from, 'sessions.json'), '[]');
  fs.writeFileSync(path.join(from, 'sub', 'x.txt'), 'x');
  assert.strictEqual(portable.hasData(from), true);
  const to = path.join(tmp, 'usb2', 'WebTerm-data', 'data');
  portable.copyData(from, to);
  assert.strictEqual(fs.readFileSync(path.join(to, 'sessions.json'), 'utf8'), '[]');
  assert.strictEqual(fs.readFileSync(path.join(to, 'sub', 'x.txt'), 'utf8'), 'x');
});

test('key: đường dẫn tương đối tính từ thư mục key, "~" là home, đường dẫn đầy đủ giữ nguyên', () => {
  const saved = process.env.WEBTERM_SSH_DIR;
  process.env.WEBTERM_SSH_DIR = path.join(tmp, 'keys');
  try {
    assert.strictEqual(resolveKeyPath('id_ed25519'), path.join(tmp, 'keys', 'id_ed25519'));
    assert.strictEqual(resolveKeyPath('sub\\id_rsa'), path.join(tmp, 'keys', 'sub', 'id_rsa'));
    assert.strictEqual(resolveKeyPath('~/.ssh/id_rsa'), path.join(os.homedir(), '.ssh', 'id_rsa'));
    assert.strictEqual(resolveKeyPath('C:\\keys\\id_rsa'), 'C:\\keys\\id_rsa');
    assert.strictEqual(resolveKeyPath(''), '');
  } finally {
    if (saved === undefined) delete process.env.WEBTERM_SSH_DIR;
    else process.env.WEBTERM_SSH_DIR = saved;
  }
});
