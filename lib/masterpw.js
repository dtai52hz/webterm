'use strict';
// Master password (giống MobaXterm): bật, tắt, đổi, mở khoá, khoá ngay.
// Khi bật: tạo khoá dữ liệu MỚI và mã hoá lại mọi secret, để bản secret.key cũ (nếu từng bị sao chép)
// không còn giải mã được gì. Trình tự ghi file đảm bảo không hỏng dữ liệu nếu bị tắt ngang (xem vault.reconcile).
const fs = require('fs');
const crypto = require('crypto');
const vault = require('./vault');
const { writeJson } = require('./jsonstore');
const store = require('./store');

const MIN_LENGTH = 6;
let failures = 0;
let nextAllowed = 0;

function bad(message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function checkNew(password) {
  if (String(password || '').length < MIN_LENGTH) throw bad(`Master password cần ít nhất ${MIN_LENGTH} ký tự`);
}

// Sai nhiều lần thì phải chờ lâu dần (0,5 s, 1 s, 2 s... tối đa 30 s).
function throttle() {
  const wait = nextAllowed - Date.now();
  if (wait > 0) throw bad(`Nhập sai nhiều lần, hãy thử lại sau ${Math.ceil(wait / 1000)} giây`, 429, { retryAfter: Math.ceil(wait / 1000) });
}

function recordFailure() {
  failures++;
  nextAllowed = Date.now() + Math.min(30_000, 250 * 2 ** failures);
}

async function openWith(password) {
  const v = vault.readVaultFile();
  if (!v) throw bad('Chưa bật master password');
  const kek = await vault.deriveKek(password, v.kdf);
  try {
    return vault.unwrap(kek, v.wrapped);
  } catch {
    return null;
  }
}

async function unlock(password) {
  throttle();
  const k = await openWith(password);
  if (!k) {
    recordFailure();
    throw bad('Master password không đúng', 401);
  }
  failures = 0;
  nextAllowed = 0;
  vault.setKey(k, { isEnabled: true });
  return vault.status();
}

function lock() {
  vault.lock();
  return vault.status();
}

// Mã hoá lại password/passphrase của mọi session từ khoá cũ sang khoá mới.
function reencryptSessions(oldKey, newKey) {
  return store.sessions.list().map((s) => {
    const out = { ...s };
    for (const f of ['password', 'passphrase']) if (s[f]) out[f] = vault.encryptWith(newKey, vault.decryptWith(oldKey, s[f]));
    return out;
  });
}

async function enable(password) {
  checkNew(password);
  const st = vault.status();
  if (st.enabled) throw bad('Master password đã được bật');
  const oldKey = vault.getKey();
  const newKey = crypto.randomBytes(32);
  const kdf = vault.kdfParams();
  const wrapped = vault.wrap(await vault.deriveKek(password, kdf), newKey);
  // 1) ghi bản mới ra file .new  2) chốt sessions  3) chốt vault + xoá secret.key
  writeJson(vault.PENDING_SESSIONS, reencryptSessions(oldKey, newKey));
  writeJson(vault.PENDING_VAULT, { v: 1, kdf, wrapped, createdAt: new Date().toISOString() });
  fs.renameSync(vault.PENDING_SESSIONS, store.sessions.file);
  fs.renameSync(vault.PENDING_VAULT, vault.VAULT_FILE);
  fs.rmSync(vault.KEY_FILE, { force: true });
  vault.setKey(newKey, { isEnabled: true });
  return vault.status();
}

async function change(oldPassword, newPassword) {
  checkNew(newPassword);
  throttle();
  const k = await openWith(oldPassword);
  if (!k) {
    recordFailure();
    throw bad('Master password hiện tại không đúng', 401);
  }
  const kdf = vault.kdfParams();
  writeJson(vault.VAULT_FILE, { v: 1, kdf, wrapped: vault.wrap(await vault.deriveKek(newPassword, kdf), k), createdAt: new Date().toISOString() });
  vault.setKey(k, { isEnabled: true });
  return vault.status();
}

async function disable(password) {
  throttle();
  const k = await openWith(password);
  if (!k) {
    recordFailure();
    throw bad('Master password không đúng', 401);
  }
  const tmp = `${vault.KEY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, k, { mode: 0o600 });
  fs.renameSync(tmp, vault.KEY_FILE);
  fs.rmSync(vault.VAULT_FILE, { force: true });
  vault.setKey(k, { isEnabled: false });
  return vault.status();
}

module.exports = { unlock, lock, enable, change, disable, status: () => vault.status() };
