'use strict';
// WebTerm: terminal SSH + SFTP + quản lý session, lấy cảm hứng từ MobaXterm.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { dataPath } = require('./lib/datadir');
const store = require('./lib/store');
const vault = require('./lib/vault');
const events = require('./lib/events');
const settings = require('./lib/settings');
const macros = require('./lib/macros');
const tunnels = require('./lib/tunnels');
const editor = require('./lib/editor');
const rdp = require('./lib/rdp');
const keygen = require('./lib/keygen');
const { sshDir } = require('./lib/keypath');
const masterpw = require('./lib/masterpw');
const backup = require('./lib/backup');

// Báo trạng thái khoá cho mọi cửa sổ; mở khoá xong thì chạy các tunnel đang chờ.
vault.onChange((st) => {
  events.emit('vault', st);
  if (!st.locked) tunnels.autoStart({ retryLocked: true });
});
const { ZipWriter } = require('./lib/zip');
const { walk } = require('./lib/remotewalk');
const { isLocalReq, LocalOnlyError } = require('./lib/guard');
const mobaxterm = require('./lib/mobaxterm');
const sftpOps = require('./lib/sftp');
const { Connection, connections } = require('./lib/connection');

// Cổng/địa chỉ thật được gán trong start() (app desktop có thể dùng cổng khác 3366).
let PORT = Number(process.env.PORT) || 3366;
let HOST = process.env.HOST || '127.0.0.1';
let LOOPBACK = true;
let LOCAL_FEATURES = false;
// App desktop chạy từ USB: thư mục WebTerm-data cạnh file .exe (null khi chạy bình thường).
let PORTABLE_DIR = null;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const UPLOAD_IDLE_MS = 120_000;

// ---------- Token truy cập ----------
// Lưu trong data/auth.token để link đã bookmark vẫn dùng được sau khi khởi động lại.
const TOKEN_FILE = dataPath('auth.token');
const TOKEN =
  process.env.WEBTERM_TOKEN ||
  (() => {
    if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('base64url'), { mode: 0o600 });
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  })();

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseCookies(header = '') {
  const out = Object.create(null);
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    // Cookie do client tự gửi: một giá trị mã hoá lỗi không được làm sập HTTP/WebSocket server.
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {}
  }
  return out;
}

const isAuthed = (req) => safeEqual(parseCookies(req.headers.cookie).wt || '', TOKEN);

// Chặn DNS rebinding: khi chỉ nghe trên loopback thì Host phải là loopback.
function hostAllowed(req) {
  if (!LOOPBACK) return true;
  const h = (req.headers.host || '').toLowerCase();
  return [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`].includes(h);
}

// Chặn trang web khác gọi API/WebSocket: Origin (nếu có) phải trùng Host.
function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return req.method === 'GET' || req.method === 'HEAD';
  try {
    return new URL(o).host === req.headers.host;
  } catch {
    return false;
  }
}

// Tính năng chạm vào máy local: bật ở mức server và request phải đến thẳng từ máy này.
const localAllowed = (req) => LOCAL_FEATURES && isLocalReq(req);

// ---------- Tiện ích HTTP ----------

function securityHeaders(req) {
  return {
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://${req.headers.host}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };
}

function sendJson(req, res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { ...securityHeaders(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON_BYTES) {
        reject(sftpOps.httpError(413, 'Dữ liệu gửi lên quá lớn'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(sftpOps.httpError(400, 'JSON không hợp lệ'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Thư viện xterm.js lấy thẳng từ node_modules, không cần CDN, chạy được khi offline.
const VENDOR = {
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/addon-web-links.js': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
  '/vendor/addon-search.js': 'node_modules/@xterm/addon-search/lib/addon-search.js',
};

function serveStatic(req, res, pathname) {
  let file;
  if (VENDOR[pathname]) {
    file = path.join(__dirname, VENDOR[pathname]);
  } else {
    let rel;
    try {
      rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    } catch {
      return false;
    }
    file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, {
    ...securityHeaders(req),
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ---------- Router ----------

const routes = [];

// pattern dạng '/api/sessions/:id'; opts.local = chỉ cho phép từ chính máy này.
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, opts });
}

async function dispatch(req, res, url) {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    if (r.opts.local && !localAllowed(req)) throw new LocalOnlyError();
    const ctx = {
      req,
      res,
      url,
      params,
      json: () => readJsonBody(req),
      send: (status, data) => sendJson(req, res, status, data),
      headers: () => securityHeaders(req),
    };
    return r.handler(ctx);
  }
  sendJson(req, res, 404, { error: 'Không tìm thấy' });
}

function getConn(id) {
  const c = connections.get(id);
  if (!c) throw sftpOps.httpError(404, 'Kết nối đã đóng');
  return c;
}

// ---------- API: hệ thống ----------

route('GET', '/api/capabilities', ({ req, send }) =>
  send(200, {
    version: require('./package.json').version,
    platform: process.platform,
    windowsBuild: require('./lib/pty').windowsBuild(),
    localFeatures: localAllowed(req),
    vault: vault.status(),
    portable: PORTABLE_DIR ? { dir: PORTABLE_DIR, keys: sshDir() } : null,
  })
);

route('GET', '/api/shells', ({ send }) => send(200, require('./lib/shells').publicList()), { local: true });

// ---------- API: master password và sao lưu ----------

route('GET', '/api/vault/status', ({ send }) => send(200, masterpw.status()));
route('POST', '/api/vault/unlock', async ({ json, send }) => send(200, await masterpw.unlock((await json()).password)));
route('POST', '/api/vault/lock', ({ send }) => send(200, masterpw.lock()));
route('POST', '/api/vault/enable', async ({ json, send }) => send(200, await masterpw.enable((await json()).password)));
route('POST', '/api/vault/disable', async ({ json, send }) => send(200, await masterpw.disable((await json()).password)));
route('POST', '/api/vault/change', async ({ json, send }) => {
  const b = await json();
  send(200, await masterpw.change(b.oldPassword, b.newPassword));
});

route('POST', '/api/backup/export', async ({ req, res, json }) => {
  const b = await json();
  const data = await backup.exportAll({ password: b.password, includeSecrets: Boolean(b.includeSecrets) });
  res.writeHead(200, {
    ...securityHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': contentDisposition(`webterm-backup-${new Date().toISOString().slice(0, 10)}.json`),
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data, null, 2));
});

route('POST', '/api/backup/import', async ({ json, send }) => {
  const b = await json();
  send(200, await backup.importAll(b.content, { password: b.password, mode: b.mode === 'replace' ? 'replace' : 'merge' }));
});

// ---------- API: RDP và SSH key ----------

route(
  'POST',
  '/api/rdp/:id/launch',
  async ({ params, json, send }) => {
    const s = store.getSession(params.id);
    if (!s || s.type !== 'rdp') return send(404, { error: 'Không tìm thấy session RDP' });
    const body = await json();
    send(200, await rdp.launch(s, { password: body.password }));
  },
  { local: true }
);

route('POST', '/api/keygen', async ({ req, json, send }) => {
  const body = await json();
  const keys = await keygen.generate(body);
  let saved = null;
  if (body.save) {
    if (!localAllowed(req)) throw new LocalOnlyError();
    saved = keygen.save(body.name, keys);
    // Chạy từ USB: session chỉ ghi tên file (tính từ WebTerm-data\keys) để vẫn dùng được khi USB đổi ký tự ổ.
    saved.sessionPath = PORTABLE_DIR ? body.name : saved.privatePath;
  }
  send(200, { ...keys, saved });
});

route('POST', '/api/sftp/:id/install-key', async ({ params, json, send }) => {
  const { publicKey } = await json();
  send(200, await keygen.install(getConn(params.id), publicKey));
});

route('GET', '/api/events', ({ req, res, headers }) => events.handle(req, res, headers()));

// ---------- API: session ----------

route('GET', '/api/sessions', ({ send }) => send(200, store.listSessions().map(store.toPublic)));

route('POST', '/api/sessions', async ({ json, send }) => send(201, store.toPublic(store.createSession(await json()))));

route('PUT', '/api/sessions/:id', async ({ params, json, send }) => {
  const s = store.updateSession(params.id, await json());
  return s ? send(200, store.toPublic(s)) : send(404, { error: 'Không tìm thấy session' });
});

route('DELETE', '/api/sessions/:id', ({ params, send }) =>
  store.deleteSession(params.id, { tunnelsUsing: tunnels.usingSession(params.id) }) ? send(200, { ok: true }) : send(404, { error: 'Không tìm thấy session' })
);

route('POST', '/api/import/mobaxterm', async ({ json, send }) => {
  const body = await json();
  let text = body.content;
  let source = 'nội dung dán vào';
  if (!text) {
    const file = mobaxterm.findIni();
    if (!file) return send(404, { error: 'Không tìm thấy MobaXterm.ini trên máy này' });
    text = mobaxterm.readIni(file);
    source = file;
  }
  const found = mobaxterm.parse(text);
  if (body.preview) return send(200, { source, sessions: found });
  return send(200, { source, found: found.length, ...store.importSessions(found) });
});

// ---------- API: cài đặt và macro ----------

route('GET', '/api/settings', ({ send }) => send(200, settings.get()));
route('PUT', '/api/settings', async ({ json, send }) => send(200, settings.update(await json())));

route('GET', '/api/macros', ({ send }) => send(200, macros.list()));
route('POST', '/api/macros', async ({ json, send }) => send(201, macros.create(await json())));
route('PUT', '/api/macros/:id', async ({ params, json, send }) => {
  const m = macros.update(params.id, await json());
  return m ? send(200, m) : send(404, { error: 'Không tìm thấy macro' });
});
route('DELETE', '/api/macros/:id', ({ params, send }) => (macros.remove(params.id) ? send(200, { ok: true }) : send(404, { error: 'Không tìm thấy macro' })));

// ---------- API: SSH tunnel ----------

route('GET', '/api/tunnels', ({ send }) => send(200, tunnels.list()));
route('POST', '/api/tunnels', async ({ json, send }) => send(201, tunnels.create(await json())));
route('PUT', '/api/tunnels/:id', async ({ params, json, send }) => {
  const t = await tunnels.update(params.id, await json());
  return t ? send(200, t) : send(404, { error: 'Không tìm thấy tunnel' });
});
route('DELETE', '/api/tunnels/:id', async ({ params, send }) => ((await tunnels.remove(params.id)) ? send(200, { ok: true }) : send(404, { error: 'Không tìm thấy tunnel' })));
route('POST', '/api/tunnels/:id/start', async ({ params, send }) => send(200, await tunnels.start(params.id)));
route('POST', '/api/tunnels/:id/stop', async ({ params, send }) => {
  await tunnels.stop(params.id);
  send(200, { ok: true });
});

route('POST', '/api/known-hosts/trust', async ({ json, send }) => send(200, tunnels.trustHostKey(await json())));
route('GET', '/api/known-hosts', ({ send }) => send(200, store.listKnownHosts()));

route('DELETE', '/api/known-hosts/:id', ({ params, send }) =>
  store.deleteKnownHost(params.id) ? send(200, { ok: true }) : send(404, { error: 'Không có' })
);

// ---------- API: SFTP ----------

route('GET', '/api/sftp/:id/download', async ({ req, res, url, params }) => {
  const sftp = await getConn(params.id).getSftp();
  const p = url.searchParams.get('path');
  const st = await sftpOps.call((cb) => sftp.stat(p, cb));
  res.writeHead(200, {
    ...securityHeaders(req),
    'Content-Type': 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': contentDisposition(path.posix.basename(p)),
    'Cache-Control': 'no-store',
  });
  const rs = sftp.createReadStream(p);
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
});

// Upload an toàn: ghi vào file tạm cạnh file đích rồi mới đổi tên. Bị huỷ giữa chừng thì xoá file tạm,
// file cũ (nếu ghi đè) vẫn nguyên vẹn.
route('PUT', '/api/sftp/:id/upload', async ({ req, url, params, send }) => {
  const sftp = await getConn(params.id).getSftp();
  const p = url.searchParams.get('path');
  if (!p || p.includes('\0')) throw sftpOps.httpError(400, 'Thiếu đường dẫn');
  const tmp = path.posix.join(path.posix.dirname(p), `.${path.posix.basename(p)}.wtpart-${crypto.randomBytes(3).toString('hex')}`);
  let mode = null;
  try {
    mode = (await sftpOps.call((cb) => sftp.stat(p, cb))).mode & 0o7777;
  } catch {}
  const removeTmp = () => sftp.unlink(tmp, () => {});
  // Upload lớn có thể kéo dài: chỉ cắt khi socket im lặng quá lâu.
  req.setTimeout(UPLOAD_IDLE_MS, () => req.destroy(new Error('Upload bị ngắt vì quá lâu không có dữ liệu')));
  await new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(tmp, mode !== null ? { mode } : {});
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      ws.destroy();
      removeTmp();
      reject(err);
    };
    ws.on('error', fail);
    ws.on('close', () => !failed && resolve());
    req.on('error', fail);
    req.on('close', () => {
      if (!req.complete) fail(Object.assign(new Error('Upload đã bị huỷ'), { status: 499 }));
    });
    req.pipe(ws);
  });
  try {
    if (mode !== null) await sftpOps.call((cb) => sftp.chmod(tmp, mode, cb));
    await sftpOps.replaceFile(sftp, tmp, p);
  } catch (e) {
    removeTmp();
    throw e;
  }
  return send(200, { ok: true });
});

// Tải nhiều mục / thư mục dạng zip: POST trả về vé dùng 1 lần (60 s), GET tải theo vé.
const zipTickets = new Map();
route('POST', '/api/sftp/:id/zip', async ({ params, json, send }) => {
  getConn(params.id);
  const { paths } = await json();
  if (!Array.isArray(paths) || !paths.length || paths.length > 5000 || paths.some((p) => typeof p !== 'string' || !p || p.includes('\0'))) {
    throw sftpOps.httpError(400, 'Danh sách đường dẫn không hợp lệ');
  }
  const ticket = crypto.randomBytes(16).toString('hex');
  zipTickets.set(ticket, { connId: params.id, paths, expires: Date.now() + 60_000 });
  setTimeout(() => zipTickets.delete(ticket), 61_000).unref();
  send(200, { ticket });
});

route('GET', '/api/sftp/:id/download-zip', async ({ req, res, url, params }) => {
  const ticket = url.searchParams.get('ticket') || '';
  const job = zipTickets.get(ticket);
  zipTickets.delete(ticket);
  if (!job || job.connId !== params.id || job.expires < Date.now()) throw sftpOps.httpError(410, 'Vé tải đã hết hạn, hãy bấm tải lại');
  const sftp = await getConn(params.id).getSftp();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const name = job.paths.length === 1 ? `${path.posix.basename(job.paths[0].replace(/\/+$/, '')) || 'root'}.zip` : `webterm-${stamp}.zip`;
  res.writeHead(200, { ...securityHeaders(req), 'Content-Type': 'application/zip', 'Content-Disposition': contentDisposition(name), 'Cache-Control': 'no-store' });
  const zip = new ZipWriter(res, { forceZip64: process.env.WEBTERM_ZIP_FORCE64 === '1' });
  const skipped = [];
  try {
    for (const root of job.paths) {
      for await (const it of walk(sftp, root, { skipped, isAborted: () => zip.aborted })) {
        if (it.type === 'dir') await zip.addDir(it.rel, it);
        else {
          const rs = sftp.createReadStream(it.full, { highWaterMark: 256 * 1024 });
          try {
            await zip.addFile(it.rel, rs, it);
          } catch (e) {
            rs.destroy();
            if (zip.aborted) throw e;
            // File hỏng giữa chừng thì không còn cách báo qua HTTP (đã gửi 200): ghi vào _LOI.txt và dừng.
            skipped.push({ path: it.full, reason: e.message });
            throw e;
          }
        }
      }
    }
    if (skipped.length) await zip.addText('_LOI.txt', `Các mục không đưa được vào file zip:\r\n\r\n${skipped.map((s) => `${s.path}: ${s.reason}`).join('\r\n')}\r\n`);
    await zip.finish();
  } catch {
    res.destroy();
  }
});

// ---------- API: sửa file bằng editor trên máy ----------

route('GET', '/api/editors', ({ send }) => send(200, { detected: editor.detectEditors(), current: settings.get().externalEditor }), { local: true });

route(
  'POST',
  '/api/sftp/:id/edit-external',
  async ({ params, json, send }) => {
    const { path: p } = await json();
    if (!p) throw sftpOps.httpError(400, 'Thiếu đường dẫn');
    send(200, await editor.openRemote(getConn(params.id), p));
  },
  { local: true }
);

route('POST', '/api/sftp/:id/edit-external/:editId/upload', async ({ params, send }) => send(200, await editor.forceUpload(params.id, params.editId)), { local: true });

route('POST', '/api/sftp/:id/:op', async ({ params, json, send }) => {
  const sftp = await getConn(params.id).getSftp();
  return send(200, await sftpOps.op(sftp, params.op, await json()));
});

// ---------- HTTP server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!hostAllowed(req)) {
    res.writeHead(421);
    return res.end('Misdirected request');
  }

  // Mở link có ?token=... một lần: đặt cookie rồi chuyển về trang chính.
  const t = url.searchParams.get('token');
  if (url.pathname === '/' && t) {
    if (!safeEqual(t, TOKEN)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Token không đúng');
    }
    res.writeHead(302, {
      'Set-Cookie': `wt=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      Location: '/',
    });
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    if (!isAuthed(req)) return sendJson(req, res, 401, { error: 'Chưa đăng nhập. Mở link có token được in trong cửa sổ chạy server.' });
    if (!originAllowed(req)) return sendJson(req, res, 403, { error: 'Origin không hợp lệ' });
    try {
      await dispatch(req, res, url);
    } catch (e) {
      if (!res.headersSent) sendJson(req, res, e.status || 500, { error: e.message, code: e.code });
      else res.destroy();
    }
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url.pathname)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

// Node mặc định cắt request sau 300 s, sẽ làm hỏng upload file lớn.
server.requestTimeout = 0;

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws/term' || !hostAllowed(req) || !isAuthed(req) || !req.headers.origin || !originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  const local = localAllowed(req);
  wss.handleUpgrade(req, socket, head, (ws) => new Connection(ws, { localFeatures: local }));
});

// Khởi động server; trả về cổng thật và link đăng nhập. Dùng chung cho CLI và app Electron.
// localFeatures: Electron truyền true; CLI mặc định bật khi chỉ nghe trên loopback (tắt bằng WEBTERM_LOCAL=0).
// portableDir: app desktop chạy từ USB truyền thư mục dữ liệu trên USB để giao diện hiển thị.
function start({ port = PORT, host = HOST, quiet = false, localFeatures, portableDir = null } = {}) {
  PORTABLE_DIR = portableDir;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      PORT = server.address().port;
      HOST = host;
      LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(host);
      LOCAL_FEATURES = localFeatures ?? (LOOPBACK && process.env.WEBTERM_LOCAL !== '0');
      const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
      const origin = `http://${shown}:${PORT}`;
      const link = `${origin}/?token=${TOKEN}`;
      if (!quiet) {
        console.log('WebTerm đang chạy.');
        console.log(`Mở link này trong trình duyệt: ${link}`);
        if (!LOOPBACK) console.warn('CẢNH BÁO: server đang mở ra ngoài máy (HOST=' + host + '). Chỉ dùng trong mạng tin cậy, và nên đặt sau HTTPS.');
      }
      tunnels.autoStart();
      editor.cleanupStale();
      resolve({ port: PORT, origin, link });
    });
  });
}

if (require.main === module) {
  start()
    .then(({ link }) => {
      if (!process.argv.includes('--open')) return;
      const { exec } = require('child_process');
      const cmd = process.platform === 'win32' ? `start "" "${link}"` : process.platform === 'darwin' ? `open "${link}"` : `xdg-open "${link}"`;
      exec(cmd);
    })
    .catch((e) => {
      console.error(e.code === 'EADDRINUSE' ? `Cổng ${PORT} đang được dùng. Đặt biến PORT khác, ví dụ PORT=3377.` : e.message);
      process.exit(1);
    });
}

module.exports = { start, server, connections, route };
