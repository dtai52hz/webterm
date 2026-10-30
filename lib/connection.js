'use strict';
// Một Connection = một tab terminal: nối WebSocket của trình duyệt với một phiên SSH hoặc một shell local.
// Frame nhị phân là dữ liệu terminal, frame text là lệnh điều khiển dạng JSON.
// Khi cần người dùng quyết định (host key, mật khẩu jump host, OTP), server gửi {type:'ask'} và chờ {type:'answer'}.
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const store = require('./store');
const monitor = require('./monitor');
const probe = require('./probe');
const { connectSsh, targetFromSession, codedError } = require('./sshclient');

const connections = new Map();
const ASK_TIMEOUT_MS = 120_000;
const TICK_MS = 3000; // nhịp chung cho giám sát và dò thư mục
const PROBE_AFTER_ENTER_MS = 400;

class Connection {
  constructor(ws, { localFeatures = false } = {}) {
    this.id = crypto.randomUUID();
    this.ws = ws;
    this.localFeatures = localFeatures;
    this.kind = null;
    this.ssh = null; // { client, close }
    this.stream = null;
    this.pty = null;
    this.sftpPromise = null;
    this.asks = new Map();
    this.ticker = null;
    this.tickBusy = false;
    this.monitorEnabled = false;
    this.monitorFailures = 0;
    this.prevSample = null;
    this.followEnabled = false;
    this.followFailures = 0;
    this.lastCwd = null;
    this.probeTimer = null;
    this.disposers = [];
    this.closed = false;
    connections.set(this.id, this);

    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('close', () => this.dispose());
    ws.on('error', () => this.dispose());
  }

  send(obj) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendData(buf) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(buf);
  }

  // Hỏi người dùng qua trình duyệt; trả về câu trả lời (hoặc {cancel:true} khi hết giờ/đóng tab).
  ask(kind, payload) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.asks.delete(id);
        resolve({ cancel: true, accept: false });
      }, ASK_TIMEOUT_MS);
      this.asks.set(id, (answer) => {
        clearTimeout(timer);
        this.asks.delete(id);
        resolve(answer);
      });
      this.send({ type: 'ask', id, kind, ...payload });
    });
  }

  onMessage(data, isBinary) {
    if (isBinary) {
      if (this.stream) {
        this.stream.write(data);
        // Vừa nhấn Enter (có thể là lệnh cd): dò lại thư mục cho panel SFTP.
        if (this.followEnabled && (data.includes(13) || data.includes(10))) this.scheduleProbe();
      } else if (this.pty) this.pty.write(this.decoder.write(data));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    switch (msg.type) {
      case 'connect':
        if (!this.kind) this.start(msg).catch((e) => this.fail(e.message, e.code));
        break;
      case 'answer': {
        const resolve = this.asks.get(msg.id);
        if (resolve) resolve(msg);
        break;
      }
      case 'resize':
        if (!Number.isInteger(msg.cols) || !Number.isInteger(msg.rows) || msg.cols <= 0 || msg.rows <= 0) break;
        if (this.stream) this.stream.setWindow(Math.min(msg.rows, 500), Math.min(msg.cols, 1000), 0, 0);
        else if (this.pty) this.pty.resize(Math.min(msg.cols, 1000), Math.min(msg.rows, 500));
        break;
      case 'monitor':
        this.setMonitor(Boolean(msg.enabled));
        break;
      case 'follow':
        this.setFollow(Boolean(msg.enabled));
        break;
    }
  }

  fail(message, code = 'error') {
    this.send({ type: 'error', code, message });
    this.dispose();
  }

  async start(msg) {
    if (msg.kind === 'local') return this.startLocal(msg);
    return this.startSsh(msg);
  }

  // ---------- SSH ----------

  resolveTarget(msg) {
    if (msg.sessionId) {
      const s = store.getSession(msg.sessionId);
      if (!s) throw codedError('Session không tồn tại', 'not-found');
      const t = targetFromSession(s, { username: msg.username, password: msg.password, passphrase: msg.passphrase, jumpPassword: msg.jumpPassword });
      return { session: s, name: s.name, startDir: s.startDir, loginCommand: s.loginCommand, ...t };
    }
    const host = String(msg.host || '').trim();
    if (!host) throw codedError('Thiếu host', 'bad-request');
    return {
      session: null,
      name: `${msg.username ? msg.username + '@' : ''}${host}`,
      host,
      port: Number(msg.port) || 22,
      username: msg.username,
      auth: 'password',
      password: msg.password || '',
      jump: null,
    };
  }

  async startSsh(msg) {
    this.kind = 'ssh';
    let t;
    try {
      t = this.resolveTarget(msg);
    } catch (e) {
      return this.fail(e.message, e.code);
    }
    if (!t.username) return this.fail('Chưa nhập username', 'need-username');
    if (t.auth === 'password' && !t.password) return this.fail('Cần mật khẩu', 'need-password');

    let conn;
    try {
      conn = await connectSsh(t, {
        ask: (kind, payload) => this.ask(kind, payload),
        onBanner: (text) => this.sendData(Buffer.from(text.replace(/\r?\n/g, '\r\n'))),
      });
    } catch (e) {
      return this.fail(e.message, e.code);
    }
    if (this.closed) return conn.close();
    this.ssh = conn;
    conn.client.on('close', () => {
      this.send({ type: 'closed' });
      this.dispose();
    });
    conn.client.on('error', () => {});

    if (t.session && msg.savePassword && msg.password) {
      try {
        store.updateSession(t.session.id, { password: msg.password });
      } catch {}
    }

    conn.client.shell({ term: 'xterm-256color', cols: msg.cols || 80, rows: msg.rows || 24 }, (err, stream) => {
      if (err) return this.fail(`Không mở được shell: ${err.message}`);
      this.stream = stream;
      stream.on('data', (d) => this.sendData(d));
      stream.stderr.on('data', (d) => this.sendData(d));
      stream.on('close', () => {
        this.send({ type: 'closed' });
        this.dispose();
      });
      this.runLoginCommands(stream, t);
      this.send({ type: 'ready', id: this.id, kind: 'ssh', name: t.name, host: t.host, port: t.port, username: t.username, viaJump: Boolean(t.jump) });
    });
  }

  // cd tới thư mục bắt đầu rồi gõ từng dòng của "lệnh khi đăng nhập", sau khi shell in ra dữ liệu đầu tiên.
  runLoginCommands(stream, t) {
    const lines = [];
    if (t.startDir) lines.push(`cd '${t.startDir.replace(/'/g, `'\\''`)}'`);
    for (const line of (t.loginCommand || '').split('\n')) if (line.trim()) lines.push(line);
    if (!lines.length) return;
    let sent = false;
    const go = () => {
      if (sent || this.closed) return;
      sent = true;
      stream.write(lines.map((l) => l + '\r').join(''));
    };
    stream.once('data', () => setTimeout(go, 150));
    setTimeout(go, 1500);
  }

  getSftp() {
    if (this.kind !== 'ssh' || !this.ssh || !this.stream) return Promise.reject(codedError('Chưa kết nối SSH', 'not-connected'));
    if (!this.sftpPromise) {
      this.sftpPromise = new Promise((resolve, reject) => {
        this.ssh.client.sftp((err, sftp) => {
          if (err) {
            this.sftpPromise = null;
            return reject(new Error(`Server không hỗ trợ SFTP: ${err.message}`));
          }
          sftp.on('close', () => (this.sftpPromise = null));
          resolve(sftp);
        });
      });
    }
    return this.sftpPromise;
  }

  // Chạy một script ngắn qua `sh -s` (không phụ thuộc login shell là bash, zsh hay fish).
  execScript(script, maxBytes = 65536) {
    return new Promise((resolve) => {
      if (!this.ssh) return resolve(null);
      this.ssh.client.exec('sh -s', (err, ch) => {
        if (err) return resolve(null);
        let out = '';
        ch.on('data', (d) => {
          if (out.length < maxBytes) out += d.toString('utf8');
        });
        ch.stderr.on('data', () => {});
        ch.on('close', () => resolve(out));
        ch.end(script);
      });
    });
  }

  setMonitor(enabled) {
    if (this.kind !== 'ssh') return;
    this.monitorEnabled = enabled;
    this.updateTicker(enabled);
  }

  setFollow(enabled) {
    if (this.kind !== 'ssh') return;
    this.followEnabled = enabled;
    this.followFailures = 0;
    if (enabled) this.lastCwd = null;
    this.updateTicker(enabled);
  }

  // Một nhịp exec chung: giám sát (nếu bật) + dò thư mục (nếu bật), để không mở quá nhiều kênh.
  updateTicker(runNow) {
    const want = this.monitorEnabled || this.followEnabled;
    if (want && !this.ticker) this.ticker = setInterval(() => this.tick(), TICK_MS);
    if (!want && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    if (want && runNow) this.tick();
  }

  scheduleProbe() {
    clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => this.tick({ probeOnly: true }), PROBE_AFTER_ENTER_MS);
  }

  async tick({ probeOnly = false } = {}) {
    if (!this.ssh || !this.stream) return;
    if (this.tickBusy) {
      if (probeOnly) this.scheduleProbe();
      return;
    }
    const doMonitor = this.monitorEnabled && !probeOnly;
    const doProbe = this.followEnabled;
    if (!doMonitor && !doProbe) return;
    this.tickBusy = true;
    const output = await this.execScript((doMonitor ? monitor.SCRIPT : '') + (doProbe ? probe.SCRIPT : ''));
    this.tickBusy = false;
    if (doMonitor) this.handleStats(output);
    if (doProbe) this.handleProbe(output);
  }

  handleStats(output) {
    const sample = output && monitor.parse(output);
    if (!sample) {
      if (++this.monitorFailures >= 2) {
        this.send({ type: 'stats', unsupported: true });
        this.setMonitor(false);
      }
      return;
    }
    this.monitorFailures = 0;
    const now = Date.now();
    const prev = this.prevSample;
    const stats = monitor.summarize(sample, prev, prev ? (now - prev.at) / 1000 : 0);
    this.prevSample = { ...sample, at: now };
    this.send({ type: 'stats', ...stats });
  }

  handleProbe(output) {
    const r = probe.parse(output);
    if (r && r.path) {
      this.followFailures = 0;
      if (r.path !== this.lastCwd) {
        this.lastCwd = r.path;
        this.send({ type: 'cwd', path: r.path });
      }
    } else if (++this.followFailures === 3) {
      // Server không hỗ trợ (không phải Linux/OpenSSH, shell bị giới hạn...): báo một lần.
      this.send({ type: 'cwd', unsupported: true, reason: r && r.none });
    }
  }

  // ---------- Terminal local ----------

  startLocal(msg) {
    this.kind = 'local';
    if (!this.localFeatures) return this.fail('Terminal local chỉ dùng được trên chính máy đang chạy WebTerm', 'local-only');
    let shellId = msg.shell;
    let cwd = msg.cwd;
    let name;
    if (msg.sessionId) {
      const s = store.getSession(msg.sessionId);
      if (!s || s.type !== 'local') return this.fail('Session terminal local không tồn tại', 'not-found');
      shellId = s.shell;
      cwd = s.startDir;
      name = s.name;
    }
    let spawned;
    try {
      spawned = require('./pty').spawnShell(shellId, { cols: msg.cols || 80, rows: msg.rows || 24, cwd });
    } catch (e) {
      return this.fail(e.message, 'pty');
    }
    this.pty = spawned.pty;
    this.decoder = new StringDecoder('utf8');
    this.pty.onData((d) => this.sendData(Buffer.from(d, 'utf8')));
    this.pty.onExit(() => {
      this.pty = null;
      this.send({ type: 'closed' });
      this.dispose();
    });
    this.send({ type: 'ready', id: this.id, kind: 'local', name: name || spawned.shell.name, shell: spawned.shell.id });
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    connections.delete(this.id);
    if (this.ticker) clearInterval(this.ticker);
    clearTimeout(this.probeTimer);
    for (const resolve of this.asks.values()) resolve({ cancel: true, accept: false });
    for (const fn of this.disposers) {
      try {
        fn();
      } catch {}
    }
    if (this.ssh) this.ssh.close();
    if (this.pty) {
      try {
        this.pty.kill();
      } catch {}
      this.pty = null;
    }
    if (this.ws.readyState === this.ws.OPEN) this.ws.close();
  }
}

module.exports = { Connection, connections };
