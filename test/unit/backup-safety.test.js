'use strict';
// Không bao giờ chạm thư mục dữ liệu thật khi thử các lỗi restore và ổ đĩa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-backup-safety-'));
process.env.WEBTERM_DATA = tmp;
process.env.WEBTERM_SCRYPT_N = '1024';
const backup = require('../../lib/backup');
const store = require('../../lib/store');
const macros = require('../../lib/macros');
const tunnels = require('../../lib/tunnels');
const settings = require('../../lib/settings');
const vault = require('../../lib/vault');
const files = ['sessions.json', 'macros.json', 'tunnels.json', 'known_hosts.json', 'settings.json'];

const ssh = (id, name, extra = {}) => ({ id, name, host: `${name}.example`, port: 22, username: 'tester', type: 'ssh', ...extra });
const tunnel = (sessionId) => ({ name: 'Forward', type: 'L', sessionId, bindHost: '127.0.0.1', bindPort: 8123, destHost: 'db.internal', destPort: 5432 });
const validBackup = () => ({
  format: 'webterm-backup', version: 1,
  sessions: [ssh('incoming', 'new')],
  macros: [{ name: 'New command', kind: 'text', text: 'pwd' }],
  tunnels: [{ ...tunnel('incoming'), bindPort: 8124 }],
  knownHosts: { 'new.example:22': { fingerprint: 'SHA256:new-key', keyType: 'ssh-ed25519' } },
  settings: { fontSize: 18 },
});
const snapshot = () => Object.fromEntries(files.map((file) => {
  const full = path.join(tmp, file);
  return [file, fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null];
}));
const assertNoRecoveryFiles = () => assert.deepEqual(fs.readdirSync(tmp).filter((file) => file.includes('.restore-')), []);

test.beforeEach(() => {
  store.sessions.save([{ ...ssh('old-session', 'old'), password: vault.encrypt('keep-me') }]);
  macros.collection.save([{ id: 'old-macro', name: 'Old command', kind: 'text', text: 'whoami' }]);
  tunnels.collection.save([{ id: 'old-tunnel', ...tunnel('old-session') }]);
  store.replaceKnownHosts({ 'old.example:22': { fingerprint: 'SHA256:old-key' } });
  settings.replaceAll({ fontSize: 15 });
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('replace từ chối cấu trúc backup lỗi trước khi ghi file hoặc dừng tunnel', async (t) => {
  let removed = 0;
  t.mock.method(tunnels, 'remove', async () => { removed++; });
  const before = snapshot();
  const variants = [
    { format: 'webterm-backup', version: 1 },
    { ...validBackup(), sessions: {} },
    { ...validBackup(), macros: 'broken' },
    { ...validBackup(), tunnels: {} },
    { ...validBackup(), settings: 'broken' },
    { ...validBackup(), knownHosts: [] },
    { ...validBackup(), version: '1' },
    { ...validBackup(), sessions: [null] },
    { ...validBackup(), macros: [null] },
    { ...validBackup(), tunnels: [null] },
  ];
  for (const data of variants) {
    await assert.rejects(backup.importAll(data, { mode: 'replace' }), (e) => e.status === 400);
    assert.deepEqual(snapshot(), before);
  }
  assert.equal(removed, 0);
  assertNoRecoveryFiles();
});

test('replace từ chối session, macro, tunnel hoặc host key lỗi mà giữ cả mật khẩu cũ', async () => {
  const before = snapshot();
  for (const patch of [
    { sessions: [ssh('incoming', 'new', { host: 'bad host' })] },
    { macros: [{ name: 'Empty command', text: '' }] },
    { tunnels: [tunnel('missing-session')] },
    { tunnels: [{ ...tunnel('incoming'), bindPort: -1 }] },
    { knownHosts: { broken: { fingerprint: 42 } } },
  ]) {
    await assert.rejects(backup.importAll({ ...validBackup(), ...patch }, { mode: 'replace' }), (e) => e.status === 400);
    assert.deepEqual(snapshot(), before);
    assert.equal(vault.decrypt(store.getSession('old-session').password), 'keep-me');
  }
});

test('replace kiểm tra cài đặt trước khi thay dữ liệu', async () => {
  if (process.platform !== 'win32') return;
  const before = snapshot();
  await assert.rejects(backup.importAll({ ...validBackup(), settings: { externalEditor: 'editor.txt' } }, { mode: 'replace' }), /Editor ngoài/);
  assert.deepEqual(snapshot(), before);
});

test('replace chặn vòng lặp, jump host bị thiếu và id session bị trùng', async () => {
  const before = snapshot();
  for (const sessions of [
    [ssh('a', 'a', { jumpSessionId: 'b' }), ssh('b', 'b', { jumpSessionId: 'a' })],
    [ssh('a', 'a', { jumpSessionId: 'gone' })],
    [ssh('a', 'a'), ssh('a', 'b')],
  ]) {
    await assert.rejects(backup.importAll({ ...validBackup(), sessions, tunnels: [] }, { mode: 'replace' }), (e) => e.status === 400);
    assert.deepEqual(snapshot(), before);
  }
});

test('replace hợp lệ remap jump/tunnel/known host và chỉ dừng tunnel sau khi lưu xong', async (t) => {
  const data = validBackup();
  data.sessions = [ssh('jump-old', 'gateway'), ssh('target-old', 'target', { jumpSessionId: 'jump-old' })];
  data.tunnels = [tunnel('target-old')];
  data.knownHosts = { 'target.example:22@jump-old': { fingerprint: 'SHA256:target-key' } };
  const stopped = [];
  t.mock.method(tunnels, 'remove', async (id) => {
    stopped.push(id);
    assert.equal(store.listSessions().length, 2);
    assert.equal(settings.get().fontSize, 18);
    assert.equal(tunnels.collection.list().length, 1);
  });
  const summary = await backup.importAll(JSON.stringify(data), { mode: 'replace' });
  const sessions = store.listSessions();
  const gateway = sessions.find((s) => s.name === 'gateway');
  const target = sessions.find((s) => s.name === 'target');
  assert.notEqual(gateway.id, 'jump-old');
  assert.equal(target.jumpSessionId, gateway.id);
  assert.equal(tunnels.collection.list()[0].sessionId, target.id);
  assert.equal(store.listKnownHosts()[`target.example:22@${gateway.id}`].fingerprint, 'SHA256:target-key');
  assert.equal(summary.sessions.added, 2);
  assert.equal(summary.tunnels.added, 1);
  assert.deepEqual(summary.warnings, []);
  assert.deepEqual(stopped, ['old-tunnel']);
  assertNoRecoveryFiles();
});

test('backup cũ thiếu phần tùy chọn vẫn nhập được, merge bỏ qua bản trùng', async () => {
  const legacy = { format: 'webterm-backup', sessions: [ssh('legacy', 'legacy')] };
  assert.equal((await backup.importAll(legacy)).sessions.added, 1);
  assert.equal((await backup.importAll(legacy)).sessions.skipped, 1);
  assert.equal(store.listSessions().length, 2);
  assertNoRecoveryFiles();
});

test('merge giữ dữ liệu cũ và cảnh báo các mục hỏng thay vì làm dở restore', async () => {
  const data = validBackup();
  data.sessions.push(null, ssh('invalid', 'broken', { host: 'bad host' }));
  data.macros.push(null);
  data.tunnels.push({ ...tunnel('incoming'), bindPort: 0 });
  const summary = await backup.importAll(data);
  assert.equal(summary.sessions.added, 1);
  assert.equal(summary.macros.added, 1);
  assert.equal(summary.tunnels.added, 1);
  assert.equal(summary.warnings.length, 4);
  assert.equal(store.listSessions().length, 2);
  assert.equal(vault.decrypt(store.getSession('old-session').password), 'keep-me');
  assert.equal(settings.get().fontSize, 15);
});

test('restore lỗi ghi ở từng bước phục hồi byte gốc cho toàn bộ file và giữ tunnel', async (t) => {
  let removed = 0;
  t.mock.method(tunnels, 'remove', async () => { removed++; });
  const targets = [
    [store.sessions, 'save'], [macros.collection, 'save'], [tunnels.collection, 'save'],
    [store, 'replaceKnownHosts'], [settings, 'replaceAll'],
  ];
  for (const mode of ['replace', 'merge']) {
    for (const [target, method] of targets) {
      if (mode === 'merge' && target === settings) continue;
      const before = snapshot();
      const original = target[method];
      target[method] = () => { throw Object.assign(new Error('Disk full during restore'), { code: 'ENOSPC' }); };
      try {
        await assert.rejects(backup.importAll(validBackup(), { mode }), /Disk full/);
      } finally {
        target[method] = original;
      }
      assert.deepEqual(snapshot(), before);
      assertNoRecoveryFiles();
    }
  }
  assert.equal(removed, 0);
});

test('không tạo được bản phục hồi thì không ghi dữ liệu và dọn các bản đã chuẩn bị', async (t) => {
  const before = snapshot();
  const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (from, to, flags) => {
    if (from === macros.collection.file) throw new Error('Recovery disk full');
    return copy(from, to, flags);
  });
  await assert.rejects(backup.importAll(validBackup(), { mode: 'replace' }), /Recovery disk full/);
  assert.deepEqual(snapshot(), before);
  assertNoRecoveryFiles();
});

test('lỗi sau khi file đã ghi xong vẫn phục hồi đúng bản gốc', async (t) => {
  const before = snapshot();
  const save = macros.collection.save;
  t.mock.method(macros.collection, 'save', (items) => {
    save(items);
    throw new Error('Write completion failed');
  });
  await assert.rejects(backup.importAll(validBackup(), { mode: 'replace' }), /Write completion failed/);
  assert.deepEqual(snapshot(), before);
  assertNoRecoveryFiles();
});

test('rollback xoá đúng các file vừa tạo trên máy chưa có dữ liệu', async (t) => {
  for (const file of files) fs.rmSync(path.join(tmp, file), { force: true });
  const before = snapshot();
  t.mock.method(settings, 'replaceAll', () => { throw new Error('Settings write failed'); });
  await assert.rejects(backup.importAll(validBackup(), { mode: 'replace' }), /Settings write failed/);
  assert.deepEqual(snapshot(), before);
  assertNoRecoveryFiles();
});

test('rollback bị chặn vẫn giữ bản sao phục hồi và trả đường dẫn rõ ràng', async (t) => {
  const oldSessions = snapshot()['sessions.json'];
  t.mock.method(macros.collection, 'save', () => { throw new Error('Commit failed'); });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from.endsWith('.bak') && to === store.sessions.file) throw new Error('Recovery rename blocked');
    return rename(from, to);
  });
  let recovery;
  await assert.rejects(backup.importAll(validBackup(), { mode: 'replace' }), (e) => {
    assert.equal(e.recoveryPaths.length, 1);
    [recovery] = e.recoveryPaths;
    assert.ok(e.message.includes(recovery));
    assert.equal(fs.readFileSync(recovery, 'utf8'), oldSessions);
    return true;
  });
  fs.rmSync(recovery);
});

test('sai mật khẩu hoặc kho đang khoá từ chối trước khi thay dữ liệu', async () => {
  const data = await backup.exportAll({ includeSecrets: true, password: 'backup-pass' });
  const before = snapshot();
  await assert.rejects(backup.importAll(data, { mode: 'replace', password: 'wrong-pass' }), /Mật khẩu backup không đúng/);
  assert.deepEqual(snapshot(), before);
  const key = Buffer.from(vault.getKey());
  vault.setKey(null);
  try {
    await assert.rejects(backup.importAll(data, { mode: 'replace', password: 'backup-pass' }), (e) => e.status === 423);
    assert.deepEqual(snapshot(), before);
  } finally {
    vault.setKey(key);
  }
});

test('dữ liệu secret giải mã được nhưng sai cấu trúc không thay thế dữ liệu', async () => {
  const data = validBackup();
  const kdf = vault.kdfParams();
  const kek = await vault.deriveKek('backup-pass', kdf);
  data.secrets = { kdf, ...vault.wrap(kek, Buffer.from(JSON.stringify({ incoming: { password: {} } }))) };
  const before = snapshot();
  await assert.rejects(backup.importAll(data, { mode: 'replace', password: 'backup-pass' }), /Dữ liệu mật khẩu/);
  assert.deepEqual(snapshot(), before);
});

test('merge giữ thay đổi của API khác trong lúc đang giải mã backup', async (t) => {
  const data = await backup.exportAll({ includeSecrets: true, password: 'backup-pass' });
  data.sessions = data.sessions.map((s) => ({ ...s, name: 'Imported copy' }));
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const derive = vault.deriveKek;
  t.mock.method(vault, 'deriveKek', async (...args) => { await waiting; return derive(...args); });
  const pending = backup.importAll(data, { password: 'backup-pass' });
  const concurrent = store.createSession({ name: 'Created during restore', host: 'concurrent.example' });
  release();
  const summary = await pending;
  assert.equal(summary.sessions.added, 1);
  assert.ok(store.getSession(concurrent.id));
  assert.equal(store.listSessions().length, 3);
  const imported = store.listSessions().find((s) => s.name === 'Imported copy');
  assert.equal(vault.decrypt(imported.password), 'keep-me');
  assertNoRecoveryFiles();
});
