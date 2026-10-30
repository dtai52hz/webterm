'use strict';
// Khoá dữ liệu dùng để mã hoá mật khẩu/passphrase đã lưu (AES-256-GCM).
//  - Chế độ thường: khoá nằm trong data/secret.key.
//  - Chế độ master password: khoá được "bọc" bằng khoá sinh từ master password (scrypt) trong data/vault.json;
//    khi app khởi động, kho ở trạng thái khoá cho tới khi người dùng nhập master password.
// Các thao tác bật/tắt/đổi master password nằm ở masterpw.js.
const fs = require('fs');
const crypto = require('crypto');
const { dataPath } = require('./datadir');
const { readJson } = require('./jsonstore');

const KEY_FILE = dataPath('secret.key');
const VAULT_FILE = dataPath('vault.json');
const PENDING_SESSIONS = dataPath('sessions.json.new');
const PENDING_VAULT = dataPath('vault.json.new');

class LockedError extends Error {
  constructor() {
    super('Kho mật khẩu đang khoá. Hãy nhập master password để dùng mật khẩu đã lưu.');
    this.status = 423;
    this.code = 'locked';
  }
}

let key = null;
let enabled = false;
const listeners = new Set();

// Đối soát nếu lần trước bị tắt ngang giữa lúc bật master password (xem masterpw.enable).
function reconcile() {
  if (fs.existsSync(PENDING_SESSIONS)) {
    // Chưa kịp chốt: huỷ phần dở dang, giữ nguyên trạng thái cũ.
    fs.rmSync(PENDING_SESSIONS, { force: true });
    fs.rmSync(PENDING_VAULT, { force: true });
  } else if (fs.existsSync(PENDING_VAULT)) {
    // sessions.json đã dùng khoá mới, chỉ còn bước đổi tên vault và xoá khoá cũ.
    fs.renameSync(PENDING_VAULT, VAULT_FILE);
    fs.rmSync(KEY_FILE, { force: true });
  }
}

function init() {
  reconcile();
  if (fs.existsSync(VAULT_FILE)) {
    enabled = true;
    key = null;
    return;
  }
  if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });
  key = fs.readFileSync(KEY_FILE);
}

function getKey() {
  if (!key) throw new LockedError();
  return key;
}

function encryptWith(k, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decryptWith(k, blob) {
  const [ver, iv, tag, ct] = String(blob).split(':');
  if (ver !== 'v1') throw new Error('Unsupported secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

const encrypt = (plain) => (plain ? encryptWith(getKey(), plain) : '');
const decrypt = (blob) => (blob ? decryptWith(getKey(), blob) : '');

// ---------- Sinh khoá từ mật khẩu (scrypt) và bọc/mở khoá dữ liệu ----------

const DEFAULT_N = Number(process.env.WEBTERM_SCRYPT_N) || 2 ** 17;

function kdfParams() {
  return { name: 'scrypt', N: DEFAULT_N, r: 8, p: 1, salt: crypto.randomBytes(16).toString('base64') };
}

function deriveKek(password, kdf) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(password), Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 512 * 1024 * 1024 }, (err, k) => (err ? reject(err) : resolve(k)))
  );
}

function wrap(kek, dataKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function unwrap(kek, w) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(w.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(w.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(w.ct, 'base64')), decipher.final()]);
}

// ---------- Trạng thái ----------

function status() {
  return { enabled, locked: !key };
}

function onChange(fn) {
  listeners.add(fn);
}

function emit() {
  for (const fn of listeners) fn(status());
}

function setKey(k, { isEnabled = enabled } = {}) {
  key = k;
  enabled = isEnabled;
  emit();
}

function lock() {
  if (!enabled || !key) return;
  key.fill(0);
  key = null;
  emit();
}

const readVaultFile = () => readJson(VAULT_FILE, null);

init();

module.exports = {
  LockedError,
  KEY_FILE,
  VAULT_FILE,
  PENDING_SESSIONS,
  PENDING_VAULT,
  getKey,
  encrypt,
  decrypt,
  encryptWith,
  decryptWith,
  kdfParams,
  deriveKek,
  wrap,
  unwrap,
  status,
  onChange,
  setKey,
  lock,
  readVaultFile,
};
