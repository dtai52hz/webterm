'use strict';
// Tiện ích dùng chung cho các test end-to-end: chạy process, gọi HTTP, mở terminal qua WebSocket.
const http = require('http');
const os = require('os');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const children = new Set();

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Chạy script Node, chờ tới khi in ra dòng "đang chạy".
function startProc(script, env = {}, { readyPattern = /đang chạy/i } = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, script)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.output = '';
  child.on('exit', () => children.delete(child));
  return new Promise((resolve, reject) => {
    const onData = (d) => {
      child.output += d;
      if (readyPattern.test(child.output)) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => (child.output += d));
    child.on('exit', (code) => reject(new Error(`${script} thoát sớm (${code}):\n${child.output}`)));
  });
}

function stopProc(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
  });
}

function killAll() {
  for (const c of children) c.kill();
}

function client({ port, token }) {
  const origin = `http://127.0.0.1:${port}`;
  const cookie = `wt=${token}`;

  function request(method, urlPath, { body, headers = {}, raw } = {}) {
    return new Promise((resolve, reject) => {
      const data = raw ?? (body !== undefined ? JSON.stringify(body) : undefined);
      const req = http.request(
        { host: '127.0.0.1', port, method, path: urlPath, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            let json = null;
            try {
              json = JSON.parse(buf.toString('utf8'));
            } catch {}
            resolve({ status: res.statusCode, headers: res.headers, buf, json });
          });
        }
      );
      req.on('error', reject);
      if (data !== undefined) req.write(data);
      req.end();
    });
  }

  const authed = (method, p, opts = {}) => request(method, p, { ...opts, headers: { Cookie: cookie, Origin: origin, ...(opts.headers || {}) } });

  // Mở một phiên terminal; tự trả lời câu hỏi host key (và prompt nếu có hàm answers).
  // manualHostKey: không tự trả lời câu hỏi host key (test tự gửi answer).
  function openTerminal(connectMsg, { acceptHostKey = true, headers, answers, manualHostKey = false } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term`, { headers: headers || { Cookie: cookie, Origin: origin } });
      const t = { ws, output: '', messages: [], hostkeyPrompts: 0, asks: [] };
      const waiters = [];
      const check = () => {
        for (const w of [...waiters]) {
          const r = w.test();
          if (r) {
            waiters.splice(waiters.indexOf(w), 1);
            clearTimeout(w.timer);
            w.resolve(r);
          }
        }
      };
      t.waitFor = (test, label, ms = 8000) =>
        new Promise((res, rej) => {
          const w = { test, resolve: res };
          w.timer = setTimeout(() => {
            waiters.splice(waiters.indexOf(w), 1);
            rej(new Error(`Hết thời gian chờ: ${label}\nOutput: ${JSON.stringify(t.output.slice(-400))}\nMessages: ${JSON.stringify(t.messages.slice(-5))}`));
          }, ms);
          waiters.push(w);
          check();
        });
      t.waitMsg = (type, ms) => t.waitFor(() => t.messages.find((m) => m.type === type && !m._seen && (m._seen = true)), `message ${type}`, ms);
      t.send = (s) => ws.send(Buffer.from(s));
      t.control = (o) => ws.send(JSON.stringify(o));
      t.close = () => new Promise((r) => (ws.readyState === WebSocket.CLOSED ? r() : (ws.once('close', r), ws.close())));
      ws.on('message', (data, isBinary) => {
        if (isBinary) t.output += data.toString('utf8');
        else {
          const msg = JSON.parse(data.toString('utf8'));
          t.messages.push(msg);
          if (msg.type === 'hostkey') {
            t.hostkeyPrompts++;
            t.control({ type: 'hostkey-reply', accept: acceptHostKey });
          } else if (msg.type === 'ask') {
            t.asks.push(msg);
            if (msg.kind === 'hostkey') {
              t.hostkeyPrompts++;
              if (!manualHostKey) t.control({ type: 'answer', id: msg.id, accept: typeof acceptHostKey === 'function' ? acceptHostKey(msg) : acceptHostKey });
            } else if (answers) {
              const values = answers(msg);
              t.control({ type: 'answer', id: msg.id, cancel: !values, values: values || [] });
            }
          }
        }
        check();
      });
      ws.on('open', () => {
        t.control({ type: 'connect', cols: 100, rows: 30, ...connectMsg });
        resolve(t);
      });
      ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`WS bị từ chối: ${res.statusCode}`), { status: res.statusCode })));
      ws.on('error', (e) => reject(e));
    });
  }

  // Đọc SSE: trả về hàm chờ sự kiện theo tên.
  function openEvents() {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { Cookie: cookie } }, (res) => {
        const ev = { status: res.statusCode, events: [], res, req };
        let buf = '';
        const waiters = [];
        res.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const type = (block.match(/^event: (.*)$/m) || [])[1];
            const data = (block.match(/^data: (.*)$/m) || [])[1];
            if (type) ev.events.push({ type, data: data ? JSON.parse(data) : null });
          }
          for (const w of [...waiters]) {
            const hit = ev.events.find((e) => e.type === w.type && !e._seen && w.filter(e.data));
            if (hit) {
              hit._seen = true;
              waiters.splice(waiters.indexOf(w), 1);
              clearTimeout(w.timer);
              w.resolve(hit.data);
            }
          }
        });
        ev.waitFor = (type, filter = () => true, ms = 8000) =>
          new Promise((res, rej) => {
            const hit = ev.events.find((e) => e.type === type && !e._seen && filter(e.data));
            if (hit) {
              hit._seen = true;
              return res(hit.data);
            }
            const w = { type, filter, resolve: res };
            w.timer = setTimeout(() => rej(new Error(`Hết thời gian chờ sự kiện ${type}`)), ms);
            waiters.push(w);
          });
        ev.close = () => req.destroy();
        resolve(ev);
      });
      req.on('error', reject);
      req.end();
    });
  }

  return { origin, cookie, request, authed, openTerminal, openEvents };
}

// Echo server TCP dùng để kiểm tra tunnel.
function echoServer(port = 0, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.pipe(sock);
    });
    srv.listen(port, host, () => resolve(srv));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, label, ms = 8000, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Hết thời gian chờ: ${label}`);
    await sleep(every);
  }
}

// Bộ đếm bước test + dọn dẹp khi xong.
function suite(name) {
  let passed = 0;
  const cleanups = [];
  return {
    async step(label, fn) {
      process.stdout.write(`• ${label} … `);
      await fn();
      passed++;
      console.log('OK');
    },
    onCleanup(fn) {
      cleanups.push(fn);
    },
    run(main) {
      console.log(`\n=== ${name} ===`);
      return main()
        .then(() => console.log(`Tất cả ${passed} bước đều đạt.`))
        .catch((e) => {
          console.log('FAIL');
          console.error(e);
          process.exitCode = 1;
        })
        .finally(async () => {
          for (const fn of cleanups.reverse()) {
            try {
              await fn();
            } catch {}
          }
          killAll();
        });
    },
  };
}

module.exports = { ROOT, tmpDir, startProc, stopProc, killAll, client, echoServer, freePort, sleep, waitUntil, suite };
