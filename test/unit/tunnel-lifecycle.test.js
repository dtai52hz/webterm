'use strict';
// Listener/SSH trả về muộn sau stop, restart hoặc restore không được hồi sinh tunnel cũ.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { EventEmitter } = require('events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-tunnel-lifecycle-'));
process.env.WEBTERM_DATA = tmp;
const sshclient = require('../../lib/sshclient');
const originalConnect = sshclient.connectSsh;
let connections;
sshclient.connectSsh = () => new Promise((resolve, reject) => connections.push({ resolve, reject }));
const tunnels = require('../../lib/tunnels');
sshclient.connectSsh = originalConnect;
const store = require('../../lib/store');
const backup = require('../../lib/backup');
const settle = () => new Promise((resolve) => setImmediate(resolve));
let listeners;

function connection() {
  return {
    client: new EventEmitter(), closeCount: 0,
    close() { this.closeCount++; this.client.emit('close'); },
  };
}
function ready(listener) { listener.ready(); }
function status() { return tunnels.list().find((d) => d.id === 'tunnel')?.status; }

test.beforeEach((t) => {
  connections = [];
  listeners = [];
  store.sessions.save([{ id: 'session', type: 'ssh', name: 'SSH', host: 'example.test', port: 22, username: 'test' }]);
  tunnels.collection.save([{ id: 'tunnel', name: 'Forward', type: 'L', sessionId: 'session', bindHost: '127.0.0.1', bindPort: 8123, destHost: 'db.internal', destPort: 5432 }]);
  t.mock.method(net, 'createServer', () => {
    const listener = new EventEmitter();
    listener.closeCount = 0;
    listener.listen = (_port, _host, callback) => { listener.ready = callback; };
    listener.close = () => { listener.closeCount++; };
    listeners.push(listener);
    return listener;
  });
});
test.afterEach(async () => { await tunnels.remove('tunnel'); });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('tunnel: restore lúc đang mở cổng đóng listener trả về muộn và không đọc definition đã xoá', async () => {
  const pending = tunnels.start('tunnel');
  await backup.importAll({ format: 'webterm-backup', version: 1, sessions: [], tunnels: [] }, { mode: 'replace' });
  ready(listeners[0]);
  assert.equal(await pending, null);
  assert.equal(listeners[0].closeCount, 1);
  assert.equal(connections.length, 0);
  assert.deepEqual(tunnels.list(), []);
});

test('tunnel: stop khi listener chưa sẵn sàng không tiếp tục kết nối SSH', async () => {
  const pending = tunnels.start('tunnel');
  await tunnels.stop('tunnel');
  ready(listeners[0]);
  assert.equal((await pending).status, 'stopped');
  assert.equal(listeners[0].closeCount, 1);
  assert.equal(connections.length, 0);
  assert.equal(status(), 'stopped');
});

test('tunnel: lỗi bind của lần start cũ không thay đổi lần restart đang chạy', async () => {
  const oldStart = tunnels.start('tunnel');
  await tunnels.stop('tunnel');
  const currentStart = tunnels.start('tunnel');
  listeners[0].emit('error', Object.assign(new Error('Old bind failed'), { code: 'EADDRINUSE' }));
  await oldStart;
  assert.equal(status(), 'starting');
  ready(listeners[1]);
  await settle();
  connections[0].resolve(connection());
  await currentStart;
  assert.equal(status(), 'running');
  assert.equal(listeners[1].closeCount, 0);
});

test('tunnel: listener của lần start cũ đóng riêng sau khi restart đã mở listener mới', async () => {
  const oldStart = tunnels.start('tunnel');
  await tunnels.stop('tunnel');
  const currentStart = tunnels.start('tunnel');
  ready(listeners[1]);
  await settle();
  connections[0].resolve(connection());
  await currentStart;
  ready(listeners[0]);
  await oldStart;
  assert.equal(listeners[0].closeCount, 1);
  assert.equal(listeners[1].closeCount, 0);
  assert.equal(connections.length, 1);
  assert.equal(status(), 'running');
});

test('tunnel: SSH cũ hoàn thành sau restart được đóng, không ghi đè kết nối mới', async () => {
  const oldStart = tunnels.start('tunnel');
  ready(listeners[0]);
  await settle();
  await tunnels.stop('tunnel');
  const currentStart = tunnels.start('tunnel');
  ready(listeners[1]);
  await settle();
  const current = connection();
  connections[1].resolve(current);
  await currentStart;
  const old = connection();
  connections[0].resolve(old);
  await oldStart;
  assert.equal(old.closeCount, 1);
  assert.equal(current.closeCount, 0);
  assert.equal(status(), 'running');
  await tunnels.stop('tunnel');
  assert.equal(current.closeCount, 1);
});

test('tunnel: lỗi SSH cũ không tạo retry và stop huỷ retry của kết nối hiện tại', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldStart = tunnels.start('tunnel');
  ready(listeners[0]);
  await settle();
  await tunnels.stop('tunnel');
  const currentStart = tunnels.start('tunnel');
  ready(listeners[1]);
  await settle();
  const current = connection();
  connections[1].resolve(current);
  await currentStart;
  connections[0].reject(Object.assign(new Error('Old network failure'), { code: 'network' }));
  await oldStart;
  assert.equal(status(), 'running');
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(connections.length, 2);
  current.client.emit('close');
  assert.equal(status(), 'reconnecting');
  await tunnels.stop('tunnel');
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(status(), 'stopped');
  assert.equal(connections.length, 2);
});

test('tunnel: SSH trả về sau khi xoá được đóng và trả null an toàn', async () => {
  const pending = tunnels.start('tunnel');
  ready(listeners[0]);
  await settle();
  await tunnels.remove('tunnel');
  const old = connection();
  connections[0].resolve(old);
  assert.equal(await pending, null);
  assert.equal(old.closeCount, 1);
  assert.equal(listeners[0].closeCount, 1);
  assert.deepEqual(tunnels.list(), []);
});
