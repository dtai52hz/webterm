'use strict';
// Sao lưu / khôi phục: session, macro, tunnel, cài đặt, known hosts. Mật khẩu đã lưu chỉ được đưa vào file
// khi người dùng đặt mật khẩu backup (scrypt + AES-256-GCM), nên file mang sang máy khác vẫn dùng được.
const crypto = require('crypto');
const fs = require('fs');
const store = require('./store');
const vault = require('./vault');
const macros = require('./macros');
const tunnels = require('./tunnels');
const settings = require('./settings');
const { dataPath } = require('./datadir');
const { resolveKeyPath } = require('./keypath');

const FORMAT = 'webterm-backup';
const VERSION = 1;
const SECRET_FIELDS = ['password', 'passphrase'];

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

const strip = (s) => {
  const out = { ...s };
  for (const f of SECRET_FIELDS) delete out[f];
  return out;
};

async function exportAll({ password, includeSecrets = false } = {}) {
  const sessions = store.listSessions();
  let secrets = null;
  if (includeSecrets) {
    if (String(password || '').length < 6) throw bad('Mật khẩu backup cần ít nhất 6 ký tự');
    const map = {};
    for (const s of sessions) {
      const entry = {};
      for (const f of SECRET_FIELDS) if (s[f]) entry[f] = vault.decrypt(s[f]); // khoá master password → 423
      if (Object.keys(entry).length) map[s.id] = entry;
    }
    const kdf = vault.kdfParams();
    const kek = await vault.deriveKek(password, kdf);
    secrets = { kdf, ...vault.wrap(kek, Buffer.from(JSON.stringify(map), 'utf8')) };
  }
  return {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    app: `WebTerm ${require('../package.json').version}`,
    sessions: sessions.map(strip),
    macros: macros.list(),
    tunnels: tunnels.collection.list(),
    settings: settings.get(),
    knownHosts: store.listKnownHosts(),
    secrets,
  };
}

async function openSecrets(secrets, password) {
  if (!secrets) return {};
  if (!password) throw bad('File backup có kèm mật khẩu đã lưu: hãy nhập mật khẩu backup');
  let map;
  try {
    const kek = await vault.deriveKek(password, secrets.kdf);
    map = JSON.parse(vault.unwrap(kek, secrets).toString('utf8'));
  } catch {
    throw bad('Mật khẩu backup không đúng');
  }
  if (!isRecord(map) || Object.values(map).some((entry) => !isRecord(entry) || SECRET_FIELDS.some((f) => entry[f] !== undefined && typeof entry[f] !== 'string'))) {
    throw bad('Dữ liệu mật khẩu trong backup không hợp lệ');
  }
  return map;
}

const sessionKey = (s) => [s.type || 'ssh', s.name, s.host, s.port, s.username].join('|').toLowerCase();
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Mọi bước kiểm tra/mã hoá đều hoàn tất trước lần ghi đầu tiên. Giữ bản sao nguyên gốc
// cho tới khi tất cả file đã lưu xong để có thể phục hồi khi ổ đĩa/rename gặp lỗi.
function commit(writes) {
  const token = crypto.randomUUID();
  const prepared = [];
  let attempted = 0;
  const recoveryPaths = [];
  try {
    for (const entry of writes) {
      JSON.stringify(entry.data); // phát hiện dữ liệu không thể ghi trước khi chạm file hiện có
      const original = fs.existsSync(entry.file);
      const recovery = `${entry.file}.restore-${token}.bak`;
      prepared.push({ ...entry, original, recovery });
      if (original) fs.copyFileSync(entry.file, recovery, fs.constants.COPYFILE_EXCL);
    }
    for (const entry of prepared) {
      attempted++;
      entry.save(entry.data);
    }
  } catch (error) {
    for (const entry of prepared.slice(0, attempted).reverse()) {
      try {
        if (entry.original) fs.renameSync(entry.recovery, entry.file);
        else fs.rmSync(entry.file, { force: true });
      } catch {
        if (entry.original) recoveryPaths.push(entry.recovery);
        else recoveryPaths.push(entry.file);
      }
    }
    if (recoveryPaths.length) {
      error.recoveryPaths = recoveryPaths;
      error.message += `. Không thể phục hồi tự động; dữ liệu phục hồi còn tại: ${recoveryPaths.join(', ')}`;
    }
    throw error;
  } finally {
    for (const entry of prepared) {
      if (recoveryPaths.includes(entry.recovery)) continue;
      try { fs.rmSync(entry.recovery, { force: true }); } catch {}
    }
  }
}

// mode: 'merge' (giữ dữ liệu hiện có, bỏ qua mục trùng) hoặc 'replace' (kiểm tra rồi thay thế).
async function importAll(input, { password, mode = 'merge' } = {}) {
  let data = input;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      throw bad('File backup không phải JSON hợp lệ');
    }
  }
  if (!isRecord(data) || data.format !== FORMAT) throw bad('Đây không phải file backup của WebTerm');
  if (data.version > VERSION) throw bad('File backup được tạo bởi phiên bản WebTerm mới hơn');
  if (data.version !== undefined && (!Number.isInteger(data.version) || data.version < 1)) throw bad('Phiên bản file backup không hợp lệ');
  if (!['merge', 'replace'].includes(mode)) throw bad('Chế độ khôi phục không hợp lệ');
  if (!Array.isArray(data.sessions)) throw bad('Danh sách session trong backup không hợp lệ');
  for (const key of ['macros', 'tunnels']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) throw bad(`Danh sách ${key} trong backup không hợp lệ`);
  }
  if (data.knownHosts !== undefined && !isRecord(data.knownHosts)) throw bad('Danh sách known hosts trong backup không hợp lệ');
  if (data.settings !== undefined && !isRecord(data.settings)) throw bad('Cài đặt trong backup không hợp lệ');
  const nextSettings = mode === 'replace' && data.settings ? settings.validate(data.settings) : null;
  const secretMap = await openSecrets(data.secrets, password);
  if (Object.keys(secretMap).length) vault.getKey(); // cần mở khoá để mã hoá lại bằng khoá của máy này

  const summary = { sessions: { added: 0, skipped: 0 }, macros: { added: 0, skipped: 0 }, tunnels: { added: 0, skipped: 0 }, knownHosts: 0, warnings: [] };
  // Sau await giải mã, đọc trạng thái mới nhất; phần lập kế hoạch và commit dưới đây không await.
  const oldTunnels = tunnels.collection.list();
  const existing = mode === 'replace' ? [] : store.listSessions();
  const byKey = new Map(existing.map((s) => [sessionKey(s), s]));
  const idMap = new Map();
  const imported = [];
  const invalid = [];
  const warnInvalid = (message) => { summary.warnings.push(message); invalid.push(message); };
  const createdAt = (value) => typeof value === 'string' && value ? value : new Date().toISOString();

  // Lượt 1: tạo session (chưa gắn jump host), ghi nhận id cũ → id mới.
  for (const s of data.sessions) {
    if (!isRecord(s)) { warnInvalid('Session trong backup không hợp lệ'); continue; }
    let clean;
    try {
      clean = store.validate({ ...s, jumpSessionId: '' }, null, existing);
    } catch (e) {
      warnInvalid(`Session "${s.name || ''}": ${e.message}`);
      continue;
    }
    const dup = byKey.get(sessionKey(clean));
    if (s.id && idMap.has(s.id) && idMap.get(s.id) !== dup?.id) {
      warnInvalid(`Session "${clean.name}": id bị trùng trong backup`);
      continue;
    }
    if (dup) {
      if (s.id) idMap.set(s.id, dup.id);
      summary.sessions.skipped++;
      continue;
    }
    const now = new Date().toISOString();
    const rec = { id: crypto.randomUUID(), ...clean, source: 'backup', createdAt: createdAt(s.createdAt), updatedAt: now };
    const sec = Object.hasOwn(secretMap, s.id) ? secretMap[s.id] : {};
    for (const f of SECRET_FIELDS) if (sec[f]) rec[f] = vault.encrypt(sec[f]);
    if (rec.privateKeyPath && !fs.existsSync(resolveKeyPath(rec.privateKeyPath))) summary.warnings.push(`Session "${rec.name}": không thấy file key ${rec.privateKeyPath} trên máy này`);
    if (s.id) idMap.set(s.id, rec.id);
    byKey.set(sessionKey(rec), rec);
    existing.push(rec);
    imported.push({ rec, jump: s.jumpSessionId });
    summary.sessions.added++;
  }
  // Lượt 2: gắn lại jump host theo id mới.
  for (const { rec, jump } of imported) {
    if (!jump || rec.type !== 'ssh') continue;
    if (!idMap.has(jump)) { warnInvalid(`Session "${rec.name}": jump host không tồn tại trong backup`); continue; }
    rec.jumpSessionId = idMap.get(jump);
  }
  // Kiểm tra toàn bộ đồ thị sau khi nối các id, kể cả vòng lặp và độ sâu quá giới hạn.
  const invalidJumps = [];
  for (const { rec } of imported) {
    try { store.validate(rec, rec.id, existing); }
    catch (e) { warnInvalid(`Session "${rec.name}": ${e.message}`); invalidJumps.push(rec); }
  }
  for (const rec of invalidJumps) rec.jumpSessionId = '';

  const macroList = mode === 'replace' ? [] : macros.collection.list();
  const haveMacros = new Set(macroList.map((m) => `${m.kind}|${m.name}`.toLowerCase()));
  for (const m of data.macros || []) {
    if (!isRecord(m)) { warnInvalid('Macro trong backup không hợp lệ'); continue; }
    try {
      const clean = macros.validate(m);
      const k = `${clean.kind}|${clean.name}`.toLowerCase();
      if (haveMacros.has(k)) { summary.macros.skipped++; continue; }
      macroList.push({ id: crypto.randomUUID(), ...clean, createdAt: createdAt(m.createdAt), updatedAt: new Date().toISOString() });
      haveMacros.add(k);
      summary.macros.added++;
    } catch (e) {
      warnInvalid(`Macro "${m.name || ''}": ${e.message}`);
    }
  }

  const tunnelList = mode === 'replace' ? [] : [...oldTunnels];
  const tKey = (t) => `${t.type}|${t.bindHost}|${t.bindPort}`;
  const haveTunnels = new Set(tunnelList.map(tKey));
  for (const t of data.tunnels || []) {
    if (!isRecord(t)) { warnInvalid('Tunnel trong backup không hợp lệ'); continue; }
    try {
      const d = tunnels.validate({ ...t, sessionId: idMap.get(t.sessionId) || t.sessionId }, existing);
      if (haveTunnels.has(tKey(d))) { summary.tunnels.skipped++; continue; }
      tunnelList.push({ id: crypto.randomUUID(), ...d, createdAt: new Date().toISOString() });
      haveTunnels.add(tKey(d));
      summary.tunnels.added++;
    } catch (e) {
      warnInvalid(`Tunnel "${t.name || ''}": ${e.message}`);
    }
  }

  const kh = store.listKnownHosts();
  for (const [k, v] of Object.entries(data.knownHosts || {})) {
    if (!isRecord(v) || typeof v.fingerprint !== 'string' || !v.fingerprint) {
      warnInvalid(`Known host "${k}": fingerprint không hợp lệ`);
      continue;
    }
    // known host của máy qua jump được lưu kèm id jump: đổi sang id mới.
    const m = k.match(/^(.*)@([^@]+)$/);
    const key = m && idMap.has(m[2]) ? `${m[1]}@${idMap.get(m[2])}` : k;
    if (!Object.hasOwn(kh, key)) {
      Object.defineProperty(kh, key, { value: v, enumerable: true, configurable: true, writable: true });
      summary.knownHosts++;
    }
  }
  // Merge vẫn nhập các mục hợp lệ; replace từ chối cả file nếu có mục lỗi để không xoá dữ liệu cũ.
  if (mode === 'replace' && invalid.length) throw bad(`Không thể thay thế dữ liệu vì backup có lỗi: ${invalid.join('; ')}`);
  const writes = [
    { file: store.sessions.file, data: existing, save: (value) => store.sessions.save(value) },
    { file: macros.collection.file, data: macroList, save: (value) => macros.collection.save(value) },
    { file: tunnels.collection.file, data: tunnelList, save: (value) => tunnels.collection.save(value) },
    { file: dataPath('known_hosts.json'), data: kh, save: (value) => store.replaceKnownHosts(value) },
  ];
  if (nextSettings) writes.push({ file: dataPath('settings.json'), data: nextSettings, save: (value) => settings.replaceAll(value) });
  commit(writes);
  // Chỉ dừng runtime sau khi chốt thành công. Trước đó không có await nên API khác không
  // thể chen giữa snapshot và rollback; restore lỗi cũng không làm ngắt tunnel đang chạy.
  if (mode === 'replace') for (const t of oldTunnels) await tunnels.remove(t.id);
  return summary;
}

module.exports = { exportAll, importAll };
