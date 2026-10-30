'use strict';
// SSH tunnel giống MobaSSHTunnel: -L (local), -R (remote), -D (SOCKS5). Mỗi tunnel giữ một kết nối SSH riêng,
// tự kết nối lại khi rớt mạng (vẫn giữ cổng -L/-D mở), và chỉ tin host key đã biết.
const net = require('net');
const crypto = require('crypto');
const { dataPath } = require('./datadir');
const { collection } = require('./jsonstore');
const store = require('./store');
const events = require('./events');
const { connectSsh, targetFromSession, labelOf } = require('./sshclient');
const { handleSocks } = require('./socks5');

const defs = collection(dataPath('tunnels.json'));
const runtime = new Map();
const seenHostKeys = new Map(); // khoá known-host -> info host key vừa thấy (dùng cho nút "Tin tưởng")
const RETRY_MIN = 2000;
const RETRY_MAX = 60_000;
const CONNECT_WAIT_MS = 10_000;

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

const validHost = (h) => /^[A-Za-z0-9._:\-\[\]]+$/.test(h);

function validate(input, sessions = store.listSessions()) {
  const type = ['L', 'R', 'D'].includes(input.type) ? input.type : 'L';
  const sessionId = String(input.sessionId || '');
  const s = sessions.find((item) => item.id === sessionId);
  if (!s || (s.type || 'ssh') !== 'ssh') throw bad('Hãy chọn một session SSH');
  const bindHost = String(input.bindHost || '127.0.0.1').trim();
  if (!validHost(bindHost)) throw bad('Địa chỉ nghe không hợp lệ');
  const bindPort = Number(input.bindPort);
  if (!Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65535) throw bad('Cổng nghe không hợp lệ');
  const out = { type, sessionId, bindHost, bindPort, autoStart: Boolean(input.autoStart) };
  if (type !== 'D') {
    const destHost = String(input.destHost || '').trim();
    if (!destHost || !validHost(destHost)) throw bad('Máy đích không hợp lệ');
    const destPort = Number(input.destPort);
    if (!Number.isInteger(destPort) || destPort < 1 || destPort > 65535) throw bad('Cổng đích không hợp lệ');
    Object.assign(out, { destHost, destPort });
  }
  const auto = type === 'D' ? `SOCKS ${bindPort} qua ${s.name}` : `${type === 'L' ? bindPort : s.name + ':' + bindPort} → ${out.destHost}:${out.destPort}`;
  out.name = String(input.name || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 100) || auto;
  return out;
}

function rt(id) {
  if (!runtime.has(id)) runtime.set(id, { status: 'stopped', error: null, errorCode: null, hostKey: null, conns: new Set(), bytesIn: 0, bytesOut: 0, wanted: false });
  return runtime.get(id);
}

function view(d) {
  const r = runtime.get(d.id);
  const s = store.getSession(d.sessionId);
  return {
    ...d,
    sessionName: s ? s.name : '(đã xoá)',
    sessionLabel: s ? labelOf(s) : '',
    status: r ? r.status : 'stopped',
    error: r ? r.error : null,
    errorCode: r ? r.errorCode : null,
    hostKey: r ? r.hostKey : null,
    connections: r ? r.conns.size : 0,
    bytesIn: r ? r.bytesIn : 0,
    bytesOut: r ? r.bytesOut : 0,
  };
}

const list = () => defs.list().map(view);

let emitTimer = null;
function changed() {
  clearTimeout(emitTimer);
  emitTimer = setTimeout(() => events.emit('tunnels', list()), 80);
}

function setStatus(r, status, err) {
  r.status = status;
  r.error = err ? err.message : null;
  r.errorCode = err ? err.code || 'error' : null;
  r.hostKey = err && err.hostKey ? err.hostKey : null;
  changed();
}

// Nối hai luồng và đếm byte để hiện trong bảng tunnel.
function pipeCounted(r, sock, ch) {
  r.conns.add(sock);
  changed();
  sock.on('data', (d) => (r.bytesOut += d.length));
  ch.on('data', (d) => (r.bytesIn += d.length));
  sock.pipe(ch).pipe(sock);
  const done = () => {
    if (r.conns.delete(sock)) changed();
    sock.destroy();
    ch.destroy();
  };
  sock.on('close', done);
  sock.on('error', done);
  ch.on('close', done);
  ch.on('error', done);
}

// Chờ kết nối SSH sẵn sàng (khi đang tự kết nối lại) trong một khoảng ngắn.
function waitConn(r) {
  if (r.conn) return Promise.resolve(r.conn);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('SSH chưa sẵn sàng')), CONNECT_WAIT_MS);
    (r.waiters ||= []).push((conn) => {
      clearTimeout(t);
      conn ? resolve(conn) : reject(new Error('SSH không kết nối được'));
    });
  });
}

function forwardOut(conn, src, dstHost, dstPort) {
  return new Promise((resolve, reject) => {
    conn.client.forwardOut(src.address || '127.0.0.1', src.port || 0, dstHost, dstPort, (err, ch) => (err ? reject(err) : resolve(ch)));
  });
}

function openListener(r, d) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sock.on('error', () => {});
      if (d.type === 'L') {
        waitConn(r)
          .then((conn) => forwardOut(conn, { address: sock.remoteAddress, port: sock.remotePort }, d.destHost, d.destPort))
          .then((ch) => pipeCounted(r, sock, ch))
          .catch(() => sock.destroy());
      } else {
        handleSocks(
          sock,
          (host, port) => waitConn(r).then((conn) => forwardOut(conn, { address: sock.remoteAddress, port: sock.remotePort }, host, port)),
          (s, ch) => pipeCounted(r, s, ch)
        );
      }
    });
    server.once('error', (e) => {
      reject(
        Object.assign(new Error(e.code === 'EADDRINUSE' ? `Cổng ${d.bindPort} trên ${d.bindHost} đang được dùng` : `Không mở được cổng ${d.bindPort}: ${e.message}`), {
          code: 'bind',
        })
      );
    });
    server.listen(d.bindPort, d.bindHost, () => {
      server.removeAllListeners('error');
      server.on('error', () => {});
      resolve(server);
    });
  });
}

function hostKeyId(info) {
  return store.hostKeyId(info.host, info.port, info.via);
}

async function connect(r, d) {
  const s = store.getSession(d.sessionId);
  if (!s) throw Object.assign(new Error('Session của tunnel đã bị xoá'), { code: 'session' });
  const target = targetFromSession(s);
  const conn = await connectSsh(target, {
    hostKeyPolicy: 'strict',
    onUnknownHostKey: (info) => seenHostKeys.set(hostKeyId(info), info),
  });
  if (d.type === 'R') {
    await new Promise((resolve, reject) =>
      conn.client.forwardIn(d.bindHost, d.bindPort, (err) => {
        if (!err) return resolve();
        conn.close();
        reject(Object.assign(new Error(`Server không cho mở cổng ${d.bindPort} (${err.message})`), { code: 'forward' }));
      })
    );
    // ssh2 chỉ báo kết nối khi chuỗi bindAddr trùng đúng chuỗi đã đăng ký.
    conn.client.on('tcp connection', (info, accept, reject) => {
      if (info.destPort !== d.bindPort) return reject();
      const sock = net.connect(d.destPort, d.destHost);
      sock.on('connect', () => pipeCounted(r, sock, accept()));
      sock.on('error', () => reject());
    });
  }
  return conn;
}

const activeAttempt = (id, r, attempt) => runtime.get(id) === r && r.attempt === attempt && r.wanted;
const currentView = (id) => {
  const d = defs.get(id);
  return d ? view(d) : null;
};

async function runLoop(id, r, attempt) {
  const d = defs.get(id);
  if (!d || !activeAttempt(id, r, attempt)) return;
  try {
    const conn = await connect(r, d);
    if (!activeAttempt(id, r, attempt)) return conn.close();
    r.conn = conn;
    r.retryDelay = RETRY_MIN;
    (r.waiters || []).splice(0).forEach((fn) => fn(conn));
    setStatus(r, 'running');
    conn.client.on('close', () => {
      if (!activeAttempt(id, r, attempt) || r.conn !== conn) return;
      r.conn = null;
      setStatus(r, 'reconnecting', Object.assign(new Error('Mất kết nối SSH, đang kết nối lại…'), { code: 'reconnecting' }));
      scheduleRetry(id, r, attempt);
    });
    conn.client.on('error', () => {});
  } catch (e) {
    if (!activeAttempt(id, r, attempt)) return;
    (r.waiters || []).splice(0).forEach((fn) => fn(null));
    // Lỗi cần người dùng xử lý thì dừng hẳn; lỗi mạng thì thử lại.
    if (['hostkey-unknown', 'auth', 'need-password', 'need-jump-password', 'key-file', 'session', 'forward', 'locked'].includes(e.code)) {
      r.wanted = e.code === 'locked'; // khoá master password: chờ mở khoá rồi tự chạy
      closeListener(r);
      setStatus(r, e.code === 'locked' ? 'locked' : 'error', e);
      return;
    }
    setStatus(r, 'reconnecting', e);
    scheduleRetry(id, r, attempt);
  }
}

function scheduleRetry(id, r, attempt) {
  if (!activeAttempt(id, r, attempt)) return;
  clearTimeout(r.retryTimer);
  r.retryDelay = Math.min(RETRY_MAX, (r.retryDelay || RETRY_MIN) * (r.retried ? 2 : 1));
  r.retried = true;
  r.retryTimer = setTimeout(() => runLoop(id, r, attempt), r.retryDelay);
}

function closeListener(r) {
  if (r.server) {
    r.server.close();
    r.server = null;
  }
  for (const s of r.conns) s.destroy();
  r.conns.clear();
}

async function start(id) {
  const d = defs.get(id);
  if (!d) throw bad('Không tìm thấy tunnel', 404);
  const r = rt(id);
  if (r.wanted && ['running', 'starting', 'reconnecting'].includes(r.status)) return view(d);
  // stop/remove hoặc lần start mới vô hiệu mọi callback listener/SSH còn đang chờ.
  const attempt = {};
  r.attempt = attempt;
  r.wanted = true;
  r.retried = false;
  r.retryDelay = RETRY_MIN;
  setStatus(r, 'starting');
  if (d.type !== 'R') {
    try {
      const server = await openListener(r, d);
      if (!activeAttempt(id, r, attempt)) {
        server.close();
        return currentView(id);
      }
      r.server = server;
    } catch (e) {
      if (!activeAttempt(id, r, attempt)) return currentView(id);
      r.wanted = false;
      setStatus(r, 'error', e);
      return view(d);
    }
  }
  await runLoop(id, r, attempt);
  return currentView(id);
}

async function stop(id) {
  const r = runtime.get(id);
  if (!r) return;
  r.wanted = false;
  r.attempt = null;
  clearTimeout(r.retryTimer);
  (r.waiters || []).splice(0).forEach((fn) => fn(null));
  closeListener(r);
  if (r.conn) {
    const d = defs.get(id);
    if (d && d.type === 'R') r.conn.client.unforwardIn(d.bindHost, d.bindPort, () => {});
    r.conn.close();
    r.conn = null;
  }
  setStatus(r, 'stopped');
}

function create(input) {
  const d = { id: crypto.randomUUID(), ...validate(input), createdAt: new Date().toISOString() };
  defs.insert(d);
  changed();
  return view(d);
}

async function update(id, input) {
  const cur = defs.get(id);
  if (!cur) return null;
  const wasRunning = runtime.get(id) && runtime.get(id).wanted;
  await stop(id);
  const next = defs.update(id, () => ({ ...cur, ...validate({ ...cur, ...input }) }));
  if (wasRunning) await start(id);
  changed();
  return view(next);
}

async function remove(id) {
  await stop(id);
  runtime.delete(id);
  const ok = defs.remove(id);
  changed();
  return ok;
}

const usingSession = (sessionId) => defs.list().filter((d) => d.sessionId === sessionId);

// Chỉ lưu đúng fingerprint mà server vừa thấy, tránh trình duyệt tự đặt fingerprint tuỳ ý.
function trustHostKey({ host, port, via, fingerprint }) {
  const info = seenHostKeys.get(store.hostKeyId(host, Number(port), via || null));
  if (!info || info.fingerprint !== fingerprint) throw bad('Không có host key nào đang chờ xác nhận khớp với yêu cầu');
  store.saveKnownHost(info.host, info.port, info.fingerprint, info.keyType, info.via);
  seenHostKeys.delete(hostKeyId(info));
  return { ok: true };
}

// Chạy các tunnel bật "tự chạy". Tunnel đang chờ mở khoá master password sẽ chạy lại khi gọi với retryLocked.
function autoStart({ retryLocked = false } = {}) {
  for (const d of defs.list()) {
    const r = runtime.get(d.id);
    if (retryLocked ? r && r.status === 'locked' : d.autoStart) start(d.id).catch(() => {});
  }
}

function stopAll() {
  for (const id of runtime.keys()) stop(id);
}

module.exports = { list, create, update, remove, start, stop, autoStart, stopAll, usingSession, trustHostKey, validate, collection: defs };
