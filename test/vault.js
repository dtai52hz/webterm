'use strict';
// Test Phase 5: master password (bật đổi khoá dữ liệu, khoá sau khi khởi động lại, sai mật khẩu bị chậm dần,
// tunnel chờ mở khoá, đổi/tắt, phục hồi sau khi bị tắt ngang) và sao lưu/khôi phục (kèm mật khẩu đã mã hoá).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { tmpDir, startProc, stopProc, client, suite, sleep, freePort, waitUntil } = require('./helpers');

const WT_PORT = 3392;
const WT2_PORT = 3391;
const SSH_PORT = 2292;
const TOKEN = 'test-token-vault';
const TMP = tmpDir('webterm-vault-');
const DATA = path.join(TMP, 'data');
const t = suite('Master password và sao lưu');
const c = client({ port: WT_PORT, token: TOKEN });
const c2 = client({ port: WT2_PORT, token: TOKEN });
const env = (port, data) => ({ PORT: port, WEBTERM_TOKEN: TOKEN, WEBTERM_DATA: data, WEBTERM_SCRYPT_N: '16384' });

t.onCleanup(() => fs.rmSync(TMP, { recursive: true, force: true }));

function decryptWith(key, blob) {
  const [, iv, tag, ct] = blob.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

async function connectOk(cl, sessionId) {
  const term = await cl.openTerminal({ sessionId });
  const m = await term.waitFor(() => term.messages.find((x) => x.type === 'ready' || x.type === 'error'), 'ready hoặc error');
  await term.close();
  return m;
}

t.run(async () => {
  await startProc('test/fake-sshd.js', { FAKE_SSHD_PORT: SSH_PORT, FAKE_SSHD_ROOT: path.join(TMP, 'sshd') });
  let wt = await startProc('server.js', env(WT_PORT, DATA));
  const restart = async () => {
    await stopProc(wt);
    wt = await startProc('server.js', env(WT_PORT, DATA));
  };

  const s = (await c.authed('POST', '/api/sessions', { body: { name: 'Có mật khẩu', host: '127.0.0.1', port: SSH_PORT, username: 'test', password: 'secret' } })).json;
  const jump = (await c.authed('POST', '/api/sessions', { body: { name: 'Qua jump', host: '127.0.0.1', port: SSH_PORT, username: 'test', password: 'secret', jumpSessionId: s.id } })).json;
  assert.strictEqual((await connectOk(c, s.id)).type, 'ready');
  const tunnelPort = await freePort();
  const tun = (await c.authed('POST', '/api/tunnels', { body: { type: 'D', sessionId: s.id, bindPort: tunnelPort, autoStart: true } })).json;

  await t.step('Bật master password: đổi sang khoá dữ liệu mới, khoá cũ không còn giải mã được', async () => {
    const oldKey = fs.readFileSync(path.join(DATA, 'secret.key'));
    assert.strictEqual((await c.authed('POST', '/api/vault/enable', { body: { password: '123' } })).status, 400);
    const r = await c.authed('POST', '/api/vault/enable', { body: { password: 'master-pass-1' } });
    assert.deepStrictEqual(r.json, { enabled: true, locked: false });
    assert.ok(!fs.existsSync(path.join(DATA, 'secret.key')), 'secret.key đã bị xoá');
    assert.ok(fs.existsSync(path.join(DATA, 'vault.json')));
    const stored = JSON.parse(fs.readFileSync(path.join(DATA, 'sessions.json'), 'utf8')).find((x) => x.id === s.id);
    assert.throws(() => decryptWith(oldKey, stored.password), 'bản secret.key cũ không giải mã được nữa');
    assert.strictEqual((await connectOk(c, s.id)).type, 'ready', 'vẫn kết nối được khi đang mở khoá');
  });

  await t.step('Khởi động lại: kho bị khoá; mật khẩu đã lưu không dùng được nhưng kết nối nhanh vẫn chạy', async () => {
    await restart();
    assert.deepStrictEqual((await c.authed('GET', '/api/capabilities')).json.vault, { enabled: true, locked: true });
    const m = await connectOk(c, s.id);
    assert.deepStrictEqual([m.type, m.code], ['error', 'locked']);
    const quick = await c.openTerminal({ host: '127.0.0.1', port: SSH_PORT, username: 'test', password: 'secret' });
    await quick.waitMsg('ready');
    await quick.close();
    assert.strictEqual((await c.authed('POST', '/api/sessions', { body: { host: '1.2.3.4', username: 'a', password: 'x' } })).status, 423);
    assert.strictEqual((await c.authed('POST', '/api/sessions', { body: { host: '1.2.3.4', username: 'a' } })).status, 201);
    const st = (await c.authed('GET', '/api/tunnels')).json.find((x) => x.id === tun.id);
    assert.strictEqual(st.status, 'locked', 'tunnel tự chạy đang chờ mở khoá');
  });

  await t.step('Mở khoá: sai thì 401 và lần thử ngay sau đó bị chặn (429); đúng thì dùng lại được mọi thứ', async () => {
    assert.strictEqual((await c.authed('POST', '/api/vault/unlock', { body: { password: 'sai' } })).status, 401);
    const blocked = await c.authed('POST', '/api/vault/unlock', { body: { password: 'master-pass-1' } });
    assert.strictEqual(blocked.status, 429);
    await sleep(700);
    const ok = await c.authed('POST', '/api/vault/unlock', { body: { password: 'master-pass-1' } });
    assert.deepStrictEqual(ok.json, { enabled: true, locked: false });
    assert.strictEqual((await connectOk(c, s.id)).type, 'ready');
    assert.strictEqual((await connectOk(c, jump.id)).type, 'ready', 'jump host dùng mật khẩu đã lưu sau khi mở khoá');
    await waitUntil(async () => (await c.authed('GET', '/api/tunnels')).json.find((x) => x.id === tun.id).status === 'running', 'tunnel chạy sau khi mở khoá', 10000, 200);
  });

  await t.step('Khoá ngay, đổi master password, mật khẩu cũ hết tác dụng', async () => {
    assert.deepStrictEqual((await c.authed('POST', '/api/vault/lock')).json, { enabled: true, locked: true });
    assert.strictEqual((await connectOk(c, s.id)).code, 'locked');
    await sleep(700);
    assert.strictEqual((await c.authed('POST', '/api/vault/change', { body: { oldPassword: 'master-pass-1', newPassword: 'master-pass-2' } })).status, 200);
    await c.authed('POST', '/api/vault/lock');
    assert.strictEqual((await c.authed('POST', '/api/vault/unlock', { body: { password: 'master-pass-1' } })).status, 401);
    await sleep(1200);
    assert.strictEqual((await c.authed('POST', '/api/vault/unlock', { body: { password: 'master-pass-2' } })).status, 200);
  });

  await t.step('Bị tắt ngang giữa lúc bật: lần khởi động sau tự hoàn tất đúng trạng thái', async () => {
    await stopProc(wt);
    // Giả lập: đã chốt sessions.json nhưng chưa kịp đổi tên vault.json.new và xoá secret.key.
    fs.renameSync(path.join(DATA, 'vault.json'), path.join(DATA, 'vault.json.new'));
    fs.writeFileSync(path.join(DATA, 'secret.key'), crypto.randomBytes(32));
    wt = await startProc('server.js', env(WT_PORT, DATA));
    assert.ok(fs.existsSync(path.join(DATA, 'vault.json')) && !fs.existsSync(path.join(DATA, 'secret.key')));
    assert.strictEqual((await c.authed('POST', '/api/vault/unlock', { body: { password: 'master-pass-2' } })).status, 200);
    assert.strictEqual((await connectOk(c, s.id)).type, 'ready');
  });

  let backupFull;
  await t.step('Sao lưu: kèm mật khẩu thì được mã hoá (không có chữ rõ), không kèm thì không có secret', async () => {
    const plain = await c.authed('POST', '/api/backup/export', { body: {} });
    assert.strictEqual(plain.json.format, 'webterm-backup');
    assert.strictEqual(plain.json.secrets, null);
    assert.match(plain.headers['content-disposition'], /webterm-backup-/);
    assert.strictEqual((await c.authed('POST', '/api/backup/export', { body: { includeSecrets: true, password: '123' } })).status, 400);
    const full = await c.authed('POST', '/api/backup/export', { body: { includeSecrets: true, password: 'backup-pass' } });
    backupFull = full.json;
    assert.ok(backupFull.secrets && backupFull.secrets.ct);
    assert.ok(!full.buf.toString('utf8').includes('"secret"') && !full.buf.toString('utf8').includes('secret"'), 'mật khẩu không xuất hiện dạng rõ');
    assert.ok(backupFull.sessions.every((x) => !('password' in x)));
  });

  await t.step('Khôi phục sang máy mới: đổi đúng id jump host và tunnel, mật khẩu dùng được; sai mật khẩu backup bị từ chối', async () => {
    await startProc('server.js', env(WT2_PORT, path.join(TMP, 'data2')));
    assert.strictEqual((await c2.authed('POST', '/api/backup/import', { body: { content: backupFull, password: 'sai-roi' } })).status, 400);
    assert.strictEqual((await c2.authed('POST', '/api/backup/import', { body: { content: { format: 'khac' } } })).status, 400);
    const r = await c2.authed('POST', '/api/backup/import', { body: { content: JSON.stringify(backupFull), password: 'backup-pass' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.sessions.added, backupFull.sessions.length);
    const sessions = (await c2.authed('GET', '/api/sessions')).json;
    const s2 = sessions.find((x) => x.name === 'Có mật khẩu');
    const j2 = sessions.find((x) => x.name === 'Qua jump');
    assert.notStrictEqual(s2.id, s.id, 'session có id mới');
    assert.strictEqual(j2.jumpSessionId, s2.id, 'jump host trỏ tới id mới');
    assert.strictEqual(s2.hasPassword, true);
    const t2 = (await c2.authed('GET', '/api/tunnels')).json;
    assert.strictEqual(t2[0].sessionId, s2.id, 'tunnel trỏ tới id mới');
    assert.ok((await c2.authed('GET', '/api/known-hosts')).json[`127.0.0.1:${SSH_PORT}`], 'known hosts được khôi phục');
    const term = await c2.openTerminal({ sessionId: j2.id });
    await term.waitMsg('ready');
    assert.strictEqual(term.hostkeyPrompts, 0, 'không hỏi lại host key nhờ known hosts đã khôi phục');
    await term.close();
    const again = await c2.authed('POST', '/api/backup/import', { body: { content: backupFull, password: 'backup-pass' } });
    assert.strictEqual(again.json.sessions.added, 0);
    assert.strictEqual(again.json.sessions.skipped, backupFull.sessions.length);
  });

  await t.step('Tắt master password: sai thì 401, đúng thì khởi động lại không cần nhập gì', async () => {
    await sleep(1500);
    assert.strictEqual((await c.authed('POST', '/api/vault/disable', { body: { password: 'sai' } })).status, 401);
    await sleep(1500);
    assert.deepStrictEqual((await c.authed('POST', '/api/vault/disable', { body: { password: 'master-pass-2' } })).json, { enabled: false, locked: false });
    await restart();
    assert.deepStrictEqual((await c.authed('GET', '/api/capabilities')).json.vault, { enabled: false, locked: false });
    assert.strictEqual((await connectOk(c, s.id)).type, 'ready');
  });
});
