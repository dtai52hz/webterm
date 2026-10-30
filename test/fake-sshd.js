'use strict';
// SSH server giả lập để test WebTerm mà không cần VPS thật.
// - User: test / mật khẩu: secret (hoặc publickey trong ~/.ssh/authorized_keys); user "otp" cần thêm mã 123456
// - Shell mini (ls, cd, pwd, cat, echo, whoami, hostname, uname, date, clear, exit, highlight-demo, altscreen)
// - SFTP thật, gốc là một thư mục tạm trên máy
// - `sh -s`: trả dữ liệu /proc giả (giám sát), thư mục hiện tại của shell (SFTP theo terminal), cài public key
// - direct-tcpip và tcpip-forward để test tunnel và jump host
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const posix = path.posix;
const { Server, utils } = require('ssh2');

const { STATUS_CODE, flagsToString } = utils.sftp;
const PORT = Number(process.env.FAKE_SSHD_PORT) || 2222;
const BASE = process.env.FAKE_SSHD_ROOT || path.join(os.tmpdir(), 'webterm-fake-sshd');
const ROOT = path.join(BASE, 'root');
const HOME = '/home/test';
const USER = 'test';
const PASSWORD = 'secret';

fs.mkdirSync(path.join(ROOT, 'home', 'test'), { recursive: true });
const welcome = path.join(ROOT, 'home', 'test', 'welcome.txt');
if (!fs.existsSync(welcome)) fs.writeFileSync(welcome, 'Xin chào từ fake-sshd!\nFile này dùng để test trình soạn thảo.\n');

const keyFile = path.join(BASE, 'host_ed25519');
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, utils.generateKeyPairSync('ed25519').private);
const hostKey = fs.readFileSync(keyFile);

// Đường dẫn ảo (POSIX) -> đường dẫn thật, không cho thoát khỏi ROOT.
function real(vpath) {
  const abs = posix.resolve(HOME, vpath || '.');
  return path.join(ROOT, ...abs.split('/').filter(Boolean));
}

// Windows không có quyền kiểu Unix, nên giữ chmod trong bộ nhớ để test.
const modes = new Map();
function attrsOf(vpath, st) {
  const abs = posix.resolve(HOME, vpath);
  const type = st.isDirectory() ? 0o040000 : st.isSymbolicLink() ? 0o120000 : 0o100000;
  const perm = modes.get(abs) ?? (st.isDirectory() ? 0o755 : 0o644);
  return { mode: type | perm, uid: 1000, gid: 1000, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) };
}

let cpuTick = 0;
function fakeProc() {
  cpuTick += 1;
  const busy = 1000 * cpuTick + Math.floor(Math.random() * 300);
  const idle = 3000 * cpuTick;
  return [
    'load 0.15 0.10 0.05',
    `cpu  ${busy} 0 ${Math.floor(busy / 3)} ${idle} 20 0 5 0 0 0`,
    'MemTotal:        4028180 kB',
    `MemAvailable:    ${2500000 - cpuTick * 1000} kB`,
    'disk 82045336 20511334',
    'up 273600.42',
    `net ${1000000 + cpuTick * 51200} ${500000 + cpuTick * 10240}`,
  ].join('\n') + '\n';
}

// conn: trạng thái theo từng kết nối SSH (thư mục hiện tại dùng cho tính năng "SFTP theo terminal").
function startShell(stream, conn = {}) {
  conn.cwd = conn.cwd || HOME;
  let line = '';
  let alt = false;
  // Gom output của mỗi lần nhận dữ liệu rồi ghi một lần (echo từng ký tự sẽ rất chậm khi paste dài).
  let buf = [];
  const write = (s) => buf.push(s);
  const flush = () => {
    if (buf.length) stream.write(buf.join(''));
    buf = [];
  };
  const prompt = () => write(`\x1b[32m${USER}@fake-vps\x1b[0m:\x1b[34m${conn.cwd.replace(HOME, '~')}\x1b[0m$ `);
  const out = (s) => write(s.replace(/\n/g, '\r\n'));
  out('Welcome to fake-vps (WebTerm test server)\n\n');
  prompt();
  flush();

  const run = (cmdline) => {
    const [cmd, ...args] = cmdline.trim().split(/\s+/);
    const arg = args.join(' ').replace(/^'(.*)'$/, '$1');
    switch (cmd) {
      case undefined:
      case '':
        break;
      case 'pwd':
        out(conn.cwd + '\n');
        break;
      case 'highlight-demo':
        out('Starting nginx... done\nERROR: connection refused\nwarning: disk almost full\nsuccess: backup completed (OK)\nserver 192.168.1.10 is active\n');
        break;
      case 'altscreen':
        // Giống vim/htop: chuyển sang alternate screen tới khi bấm q.
        alt = true;
        write('\x1b[?1049h\x1b[2J\x1b[H== ALT SCREEN (bấm q để thoát) ==\r\nplain text here\r\n');
        return true;
      case 'whoami':
        out(USER + '\n');
        break;
      case 'hostname':
        out('fake-vps\n');
        break;
      case 'uname':
        out('Linux fake-vps 6.8.0-fake #1 SMP x86_64 GNU/Linux\n');
        break;
      case 'date':
        out(new Date().toString() + '\n');
        break;
      case 'echo':
        out(args.join(' ') + '\n');
        break;
      case 'clear':
        write('\x1b[2J\x1b[H');
        break;
      case 'cd': {
        const target = posix.resolve(conn.cwd, arg || HOME);
        try {
          if (fs.statSync(real(target)).isDirectory()) conn.cwd = target;
          else out(`cd: ${arg}: Not a directory\n`);
        } catch {
          out(`cd: ${arg}: No such file or directory\n`);
        }
        break;
      }
      case 'ls': {
        try {
          const names = fs.readdirSync(real(posix.resolve(conn.cwd, arg || '.')), { withFileTypes: true });
          out(names.map((d) => (d.isDirectory() ? `\x1b[34m${d.name}\x1b[0m` : d.name)).join('  ') + '\n');
        } catch {
          out(`ls: cannot access '${arg}': No such file or directory\n`);
        }
        break;
      }
      case 'cat':
        try {
          out(fs.readFileSync(real(posix.resolve(conn.cwd, arg)), 'utf8'));
        } catch {
          out(`cat: ${arg}: No such file or directory\n`);
        }
        break;
      case 'exit':
        out('logout\n');
        flush();
        stream.exit(0);
        stream.end();
        return false;
      default:
        out(`${cmd}: command not found\n`);
    }
    prompt();
    return true;
  };

  stream.on('data', (data) => {
    for (const ch of data.toString('utf8')) {
      if (alt) {
        if (ch === 'q') {
          alt = false;
          write('\x1b[?1049l');
          prompt();
        }
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        write('\r\n');
        const keep = run(line);
        line = '';
        if (!keep) return;
      } else if (ch === '\x7f' || ch === '\b') {
        if (line) {
          line = line.slice(0, -1);
          write('\b \b');
        }
      } else if (ch === '\x03') {
        line = '';
        write('^C\r\n');
        prompt();
      } else if (ch >= ' ' && ch !== '\x1b') {
        line += ch;
        write(ch);
      }
    }
    flush();
  });
}

function startSftp(sftp) {
  const handles = new Map();
  let next = 0;
  const newHandle = (value) => {
    const h = Buffer.alloc(4);
    h.writeUInt32BE(next++);
    handles.set(h.toString('hex'), value);
    return h;
  };
  const get = (h) => handles.get(h.toString('hex'));
  const fail = (reqid, err) => sftp.status(reqid, err && err.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : err && err.code === 'EACCES' ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE, err ? err.message : undefined);
  const ok = (reqid) => sftp.status(reqid, STATUS_CODE.OK);

  sftp.on('REALPATH', (reqid, p) => {
    const abs = posix.resolve(HOME, p || '.');
    sftp.name(reqid, [{ filename: abs, longname: abs, attrs: {} }]);
  });
  const statHandler = (useLstat) => (reqid, p) => {
    try {
      const st = useLstat ? fs.lstatSync(real(p)) : fs.statSync(real(p));
      sftp.attrs(reqid, attrsOf(p, st));
    } catch (e) {
      fail(reqid, e);
    }
  };
  sftp.on('STAT', statHandler(false));
  sftp.on('LSTAT', statHandler(true));
  sftp.on('FSTAT', (reqid, handle) => {
    const h = get(handle);
    if (!h || h.fd === undefined) return fail(reqid);
    sftp.attrs(reqid, attrsOf(h.vpath, fs.fstatSync(h.fd)));
  });
  sftp.on('OPENDIR', (reqid, p) => {
    try {
      if (!fs.statSync(real(p)).isDirectory()) return fail(reqid);
      sftp.handle(reqid, newHandle({ dir: posix.resolve(HOME, p), done: false }));
    } catch (e) {
      fail(reqid, e);
    }
  });
  sftp.on('READDIR', (reqid, handle) => {
    const h = get(handle);
    if (!h || !h.dir) return fail(reqid);
    if (h.done) return sftp.status(reqid, STATUS_CODE.EOF);
    h.done = true;
    const names = fs.readdirSync(real(h.dir)).map((name) => {
      const vp = posix.join(h.dir, name);
      const attrs = attrsOf(vp, fs.lstatSync(real(vp)));
      return { filename: name, longname: name, attrs };
    });
    if (!names.length) return sftp.status(reqid, STATUS_CODE.EOF);
    sftp.name(reqid, names);
  });
  sftp.on('OPEN', (reqid, p, flags) => {
    try {
      const mode = flagsToString(flags);
      if (!mode) return fail(reqid);
      const fd = fs.openSync(real(p), mode);
      sftp.handle(reqid, newHandle({ fd, vpath: posix.resolve(HOME, p) }));
    } catch (e) {
      fail(reqid, e);
    }
  });
  sftp.on('READ', (reqid, handle, offset, length) => {
    const h = get(handle);
    if (!h || h.fd === undefined) return fail(reqid);
    const buf = Buffer.alloc(length);
    const n = fs.readSync(h.fd, buf, 0, length, offset);
    if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF);
    sftp.data(reqid, buf.subarray(0, n));
  });
  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const h = get(handle);
    if (!h || h.fd === undefined) return fail(reqid);
    fs.writeSync(h.fd, data, 0, data.length, offset);
    ok(reqid);
  });
  sftp.on('CLOSE', (reqid, handle) => {
    const h = get(handle);
    if (!h) return fail(reqid);
    if (h.fd !== undefined) fs.closeSync(h.fd);
    handles.delete(handle.toString('hex'));
    ok(reqid);
  });
  const wrap = (fn) => (reqid, ...args) => {
    try {
      fn(...args);
      ok(reqid);
    } catch (e) {
      fail(reqid, e);
    }
  };
  sftp.on('REMOVE', wrap((p) => fs.unlinkSync(real(p))));
  sftp.on('RMDIR', wrap((p) => fs.rmdirSync(real(p))));
  sftp.on('MKDIR', wrap((p) => fs.mkdirSync(real(p))));
  sftp.on('RENAME', wrap((from, to) => {
    // Giống SFTP thật: rename thường không ghi đè file đã tồn tại.
    if (fs.existsSync(real(to))) throw Object.assign(new Error('File exists'), { code: 'EEXIST' });
    fs.renameSync(real(from), real(to));
    const fromAbs = posix.resolve(HOME, from);
    if (modes.has(fromAbs)) {
      modes.set(posix.resolve(HOME, to), modes.get(fromAbs));
      modes.delete(fromAbs);
    }
  }));
  sftp.on('SETSTAT', wrap((p, attrs) => {
    fs.statSync(real(p));
    if (attrs.mode !== undefined) modes.set(posix.resolve(HOME, p), attrs.mode & 0o7777);
  }));
  sftp.on('FSETSTAT', (reqid) => ok(reqid));
}

const AUTH_KEYS = path.join(ROOT, 'home', 'test', '.ssh', 'authorized_keys');
const OTP_CODE = '123456';
const log = (msg) => console.log(`[fake-sshd] ${msg}`);

function authorizedKeys() {
  try {
    return fs
      .readFileSync(AUTH_KEYS, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => utils.parseKey(l))
      .filter((k) => !(k instanceof Error));
  } catch {
    return [];
  }
}

// Mô phỏng script cài public key kiểu ssh-copy-id mà WebTerm gửi qua `sh -s`.
function installKey(script) {
  const m = script.match(/^KEY='([^']+)'$/m);
  if (!m) return 'error no key\n';
  fs.mkdirSync(path.dirname(AUTH_KEYS), { recursive: true });
  const existing = fs.existsSync(AUTH_KEYS) ? fs.readFileSync(AUTH_KEYS, 'utf8') : '';
  const blob = m[1].split(/\s+/)[1];
  if (existing.split(/\r?\n/).some((l) => l.split(/\s+/)[1] === blob)) return 'webterm-key exists\n';
  fs.writeFileSync(AUTH_KEYS, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + m[1] + '\n');
  return 'webterm-key installed\n';
}

function handleExecScript(script, conn) {
  if (script.includes('webterm-install-key')) return installKey(script);
  let out = '';
  if (script.includes('webterm-monitor')) out += fakeProc();
  if (script.includes('webterm-probe')) out += `cwd ${conn.cwd || HOME}\n`;
  return out || fakeProc();
}

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  const conn = { cwd: HOME, forwards: new Map() };

  client.on('authentication', (ctx) => {
    if (ctx.username === 'otp') {
      // User có xác thực 2 bước: mật khẩu + mã OTP qua keyboard-interactive.
      if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
      return ctx.prompt(
        [
          { prompt: 'Password: ', echo: false },
          { prompt: 'Verification code: ', echo: true },
        ],
        'Two-factor',
        (answers) => (answers[0] === PASSWORD && answers[1] === OTP_CODE ? ctx.accept() : ctx.reject())
      );
    }
    if (ctx.username !== USER) return ctx.reject();
    if (ctx.method === 'password' && ctx.password === PASSWORD) return ctx.accept();
    if (ctx.method === 'publickey') {
      const pk = authorizedKeys().find((k) => ctx.key.data.equals(k.getPublicSSH()));
      if (!pk) return ctx.reject();
      if (!ctx.signature) return ctx.accept(); // bước hỏi thử (PK_OK)
      return pk.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject();
    }
    if (ctx.method === 'keyboard-interactive') {
      return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => (answers[0] === PASSWORD ? ctx.accept() : ctx.reject()));
    }
    ctx.reject(['password', 'publickey', 'keyboard-interactive']);
  });

  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (acc) => acc && acc());
      session.on('window-change', (acc) => acc && acc());
      session.on('shell', (acc) => startShell(acc(), conn));
      session.on('exec', (acc, _rej, info) => {
        const stream = acc();
        if (info.command === 'sh -s') {
          let script = '';
          stream.on('data', (d) => (script += d));
          stream.on('end', () => {
            stream.write(handleExecScript(script, conn));
            stream.exit(0);
            stream.end();
          });
        } else {
          stream.write(`exec: ${info.command}\n`);
          stream.exit(0);
          stream.end();
        }
      });
      session.on('sftp', (acc) => startSftp(acc()));
    });

    // direct-tcpip: dùng cho tunnel -L/-D và jump host.
    client.on('tcpip', (accept, reject, info) => {
      log(`TCPIP ${info.destIP}:${info.destPort}`);
      if (process.env.FAKE_SSHD_DENY_TCPIP === '1') return reject();
      const sock = net.connect(info.destPort, info.destIP);
      sock.on('connect', () => {
        const ch = accept();
        ch.pipe(sock).pipe(ch);
        ch.on('close', () => sock.destroy());
        sock.on('close', () => ch.close());
      });
      sock.on('error', () => reject());
    });

    // tcpip-forward: dùng cho tunnel -R.
    client.on('request', (accept, reject, name, info) => {
      if (name === 'tcpip-forward') {
        const srv = net.createServer((sock) => {
          client.forwardOut(info.bindAddr, srv.address().port, sock.remoteAddress, sock.remotePort, (err, ch) => {
            if (err) return sock.destroy();
            ch.pipe(sock).pipe(ch);
            ch.on('close', () => sock.destroy());
            sock.on('close', () => ch.close());
          });
        });
        srv.on('error', () => reject && reject());
        srv.listen(info.bindPort, info.bindAddr === '' || info.bindAddr === '0.0.0.0' ? '127.0.0.1' : info.bindAddr, () => {
          conn.forwards.set(`${info.bindAddr}:${info.bindPort}`, srv);
          log(`FORWARD ${info.bindAddr}:${srv.address().port}`);
          if (accept) accept(info.bindPort === 0 ? srv.address().port : undefined);
        });
      } else if (name === 'cancel-tcpip-forward') {
        const srv = conn.forwards.get(`${info.bindAddr}:${info.bindPort}`);
        if (srv) srv.close();
        conn.forwards.delete(`${info.bindAddr}:${info.bindPort}`);
        if (accept) accept();
      } else if (reject) reject();
    });
  });
  client.on('close', () => conn.forwards.forEach((srv) => srv.close()));
  client.on('error', () => {});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fake-sshd đang chạy ở 127.0.0.1:${PORT} (user: ${USER} / mật khẩu: ${PASSWORD})`);
  console.log(`Thư mục gốc SFTP: ${ROOT}`);
});
