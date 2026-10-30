'use strict';
// Lưu session và known hosts. Mật khẩu/passphrase được mã hoá qua vault.js.
const crypto = require('crypto');
const { DATA_DIR, dataPath } = require('./datadir');
const { readJson, writeJson, collection } = require('./jsonstore');
const vault = require('./vault');

const sessions = collection(dataPath('sessions.json'));
const KNOWN_HOSTS_FILE = dataPath('known_hosts.json');

const TYPES = ['ssh', 'rdp', 'local'];
const MAX_JUMP_DEPTH = 3;

const PUBLIC_FIELDS = [
  'id', 'name', 'folder', 'type', 'host', 'port', 'username', 'auth', 'privateKeyPath', 'startDir', 'loginCommand',
  'notes', 'jumpSessionId', 'shell', 'rdpAuth', 'rdpFullscreen', 'color', 'source', 'createdAt', 'updatedAt',
];

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function toPublic(s) {
  const out = {};
  for (const k of PUBLIC_FIELDS) if (s[k] !== undefined) out[k] = s[k];
  out.type = s.type || 'ssh';
  out.hasPassword = Boolean(s.password);
  out.hasPassphrase = Boolean(s.passphrase);
  return out;
}

function cleanText(v, max = 255) {
  return String(v ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
}

// Giữ xuống dòng (ghi chú, lệnh khi đăng nhập), chuẩn hoá về \n.
function cleanMultiline(v, max = 4000) {
  return String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\0\x1b]/g, '').slice(0, max).trimEnd();
}

function validHost(host) {
  if (!host) throw badRequest('Host không được để trống');
  if (!/^[A-Za-z0-9._:\-\[\]]+$/.test(host)) throw badRequest('Host không hợp lệ');
  return host;
}

function validPort(v, def) {
  const port = Number(v || def);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest('Port không hợp lệ');
  return port;
}

// Kiểm tra chuỗi jump host: phải là session SSH khác, không vòng lặp, tối đa 3 tầng.
function checkJump(selfId, jumpId, all) {
  if (!jumpId) return '';
  let cur = jumpId;
  for (let depth = 1; cur; depth++) {
    if (cur === selfId) throw badRequest('Jump host tạo thành vòng lặp');
    if (depth > MAX_JUMP_DEPTH) throw badRequest(`Chỉ hỗ trợ tối đa ${MAX_JUMP_DEPTH} tầng jump host`);
    const s = all.find((x) => x.id === cur);
    if (!s) throw badRequest('Jump host không tồn tại');
    if ((s.type || 'ssh') !== 'ssh') throw badRequest('Jump host phải là session SSH');
    cur = s.jumpSessionId;
  }
  return jumpId;
}

function validate(input, selfId = null, all = sessions.list()) {
  const type = TYPES.includes(input.type) ? input.type : 'ssh';
  const base = {
    type,
    folder: cleanText(input.folder).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
    color: /^#[0-9a-fA-F]{6}$/.test(input.color || '') ? input.color : '',
    notes: cleanMultiline(input.notes),
  };
  if (type === 'local') {
    const shell = cleanText(input.shell, 64) || 'powershell';
    return { ...base, name: cleanText(input.name) || 'Terminal local', shell, startDir: cleanText(input.startDir, 1024) };
  }
  const host = validHost(cleanText(input.host));
  if (type === 'rdp') {
    return {
      ...base,
      name: cleanText(input.name) || host,
      host,
      port: validPort(input.port, 3389),
      username: cleanText(input.username, 128),
      rdpAuth: ['dpapi', 'credman', 'prompt'].includes(input.rdpAuth) ? input.rdpAuth : 'dpapi',
      rdpFullscreen: Boolean(input.rdpFullscreen),
    };
  }
  const auth = ['password', 'key'].includes(input.auth) ? input.auth : 'password';
  return {
    ...base,
    name: cleanText(input.name) || host,
    host,
    port: validPort(input.port, 22),
    username: cleanText(input.username, 64),
    auth,
    privateKeyPath: auth === 'key' ? cleanText(input.privateKeyPath, 1024) : '',
    startDir: cleanText(input.startDir, 1024),
    loginCommand: cleanMultiline(input.loginCommand),
    jumpSessionId: checkJump(selfId, cleanText(input.jumpSessionId, 64), all),
  };
}

// password/passphrase: undefined = giữ nguyên, '' = xoá, chuỗi = lưu mới.
function applySecrets(target, input) {
  if (input.password !== undefined) target.password = input.password ? vault.encrypt(input.password) : '';
  if (input.passphrase !== undefined) target.passphrase = input.passphrase ? vault.encrypt(input.passphrase) : '';
}

const listSessions = () => sessions.list();
const getSession = (id) => sessions.get(id);

function createSession(input) {
  const now = new Date().toISOString();
  const s = { id: crypto.randomUUID(), ...validate(input), source: input.source || 'manual', createdAt: now, updatedAt: now };
  applySecrets(s, input);
  return sessions.insert(s);
}

function updateSession(id, input) {
  const all = sessions.list();
  const cur = all.find((s) => s.id === id);
  if (!cur) return null;
  const next = { ...cur, ...validate({ ...cur, ...input }, id, all), updatedAt: new Date().toISOString() };
  applySecrets(next, input);
  // Bỏ các trường của kiểu cũ khi đổi kiểu session.
  if (next.type !== 'ssh') ['auth', 'privateKeyPath', 'passphrase', 'loginCommand', 'jumpSessionId'].forEach((k) => delete next[k]);
  if (next.type === 'local') ['host', 'port', 'username', 'password'].forEach((k) => delete next[k]);
  if (next.type !== 'rdp') ['rdpAuth', 'rdpFullscreen'].forEach((k) => delete next[k]);
  if (next.type !== 'local') delete next.shell;
  return sessions.update(id, () => next);
}

// Session đang được dùng làm jump host hoặc tunnel thì không cho xoá.
function deleteSession(id, { tunnelsUsing = [] } = {}) {
  const users = sessions.list().filter((s) => s.jumpSessionId === id);
  if (users.length || tunnelsUsing.length) {
    const names = [...users.map((s) => `session "${s.name}"`), ...tunnelsUsing.map((t) => `tunnel "${t.name}"`)];
    const e = new Error(`Không xoá được: đang được dùng bởi ${names.join(', ')}`);
    e.status = 409;
    throw e;
  }
  return sessions.remove(id);
}

// Thêm nhiều session cùng lúc, bỏ qua những cái trùng name+host+port+username.
function importSessions(items) {
  const list = sessions.list();
  const key = (s) => [s.name, s.host, s.port, s.username].join('|').toLowerCase();
  const seen = new Set(list.map(key));
  const now = new Date().toISOString();
  let added = 0;
  let skipped = 0;
  const errors = [];
  for (const item of items) {
    let s;
    try {
      s = { id: crypto.randomUUID(), ...validate({ ...item, jumpSessionId: '' }, null, list), source: item.source || 'import', createdAt: now, updatedAt: now };
    } catch (e) {
      errors.push(`${item.name || item.host}: ${e.message}`);
      continue;
    }
    if (seen.has(key(s))) {
      skipped++;
      continue;
    }
    seen.add(key(s));
    list.push(s);
    added++;
  }
  sessions.save(list);
  return { added, skipped, errors };
}

function sessionSecrets(s) {
  return { password: vault.decrypt(s.password), passphrase: vault.decrypt(s.passphrase) };
}

// ---------- Known hosts (TOFU) ----------
// Máy đi qua jump host được lưu kèm id jump để không lẫn khi cùng IP nội bộ nằm sau gateway khác nhau.

function hostKeyId(host, port, via) {
  return via ? `${host}:${port}@${via}` : `${host}:${port}`;
}

function getKnownHost(host, port, via) {
  return readJson(KNOWN_HOSTS_FILE, {})[hostKeyId(host, port, via)] || null;
}

function saveKnownHost(host, port, fingerprint, keyType, via) {
  const all = readJson(KNOWN_HOSTS_FILE, {});
  all[hostKeyId(host, port, via)] = { fingerprint, keyType, addedAt: new Date().toISOString() };
  writeJson(KNOWN_HOSTS_FILE, all);
}

function listKnownHosts() {
  return readJson(KNOWN_HOSTS_FILE, {});
}

function replaceKnownHosts(all) {
  writeJson(KNOWN_HOSTS_FILE, all);
}

function deleteKnownHost(id) {
  const all = readJson(KNOWN_HOSTS_FILE, {});
  if (!all[id]) return false;
  delete all[id];
  writeJson(KNOWN_HOSTS_FILE, all);
  return true;
}

module.exports = {
  DATA_DIR,
  sessions,
  badRequest,
  cleanText,
  cleanMultiline,
  toPublic,
  validate,
  listSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  importSessions,
  sessionSecrets,
  hostKeyId,
  getKnownHost,
  saveKnownHost,
  listKnownHosts,
  replaceKnownHosts,
  deleteKnownHost,
};
