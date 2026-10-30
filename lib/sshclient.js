'use strict';
// Mở kết nối SSH (kể cả qua jump host). Dùng chung cho tab terminal và tunnel.
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('ssh2');
const store = require('./store');
const vault = require('./vault');
const { resolveKeyPath } = require('./keypath');

const HANDSHAKE_MS = Number(process.env.WEBTERM_HANDSHAKE_MS) || 20_000;
const MAX_JUMP_DEPTH = 3;

function fingerprint(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

// Blob khoá SSH bắt đầu bằng chuỗi tên thuật toán (uint32 độ dài + chuỗi).
function keyType(key) {
  try {
    const len = key.readUInt32BE(0);
    return key.subarray(4, 4 + len).toString('ascii');
  } catch {
    return 'unknown';
  }
}

function codedError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

const labelOf = (t) => `${t.username ? t.username + '@' : ''}${t.host}${t.port && t.port !== 22 ? ':' + t.port : ''}`;

// Thông tin đăng nhập của một session đã lưu (kèm chuỗi jump host). Chỉ giải mã secret khi thật sự cần.
function targetFromSession(s, overrides = {}, depth = 0) {
  if ((s.type || 'ssh') !== 'ssh') throw codedError('Session này không phải SSH', 'bad-type');
  const t = {
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port || 22,
    username: overrides.username || s.username,
    auth: s.auth || 'password',
    privateKeyPath: s.privateKeyPath,
    password: overrides.password || (s.password ? vault.decrypt(s.password) : ''),
    passphrase: overrides.passphrase || (s.passphrase ? vault.decrypt(s.passphrase) : ''),
    jump: null,
  };
  if (s.jumpSessionId) {
    if (depth >= MAX_JUMP_DEPTH) throw codedError(`Chỉ hỗ trợ tối đa ${MAX_JUMP_DEPTH} tầng jump host`, 'jump-depth');
    const j = store.getSession(s.jumpSessionId);
    if (!j) throw codedError('Jump host của session này không còn tồn tại', 'jump-missing');
    t.jump = targetFromSession(j, { password: overrides.jumpPassword }, depth + 1);
  }
  return t;
}

function friendlyError(err, t) {
  const where = `${t.host}:${t.port}`;
  if (err.code === 'ECONNREFUSED') return codedError(`Không kết nối được tới ${where} (cổng đóng hoặc sai port)`, 'network');
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return codedError(`Không tìm thấy host ${t.host}`, 'network');
  if (['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(err.code)) return codedError(`Không tới được ${where} (hết thời gian chờ)`, 'network');
  if (err.level === 'client-authentication' || /authentication methods failed/i.test(err.message)) {
    return codedError(`Sai username hoặc mật khẩu/khoá cho ${labelOf(t)}`, 'auth');
  }
  if (/verification failed/i.test(err.message)) return codedError(`Đã từ chối host key của ${where}`, 'hostkey');
  return codedError(`Lỗi kết nối ${where}: ${err.message}`, err.code || 'error');
}

// Mở kênh direct-tcpip qua jump host tới máy đích.
function forwardThrough(jumpClient, jump, host, port) {
  return new Promise((resolve, reject) => {
    jumpClient.forwardOut('127.0.0.1', 0, host, port, (err, ch) => {
      if (!err) return resolve(ch);
      const prohibited = /prohibited/i.test(err.message);
      reject(
        codedError(
          prohibited
            ? `Jump host ${labelOf(jump)} không cho chuyển tiếp kết nối (AllowTcpForwarding no)`
            : `Jump host ${labelOf(jump)} không mở được kết nối tới ${host}:${port}: ${err.message}`,
          'jump-forward'
        )
      );
    });
  });
}

// hooks.ask(kind, payload) => Promise<answer>: hỏi người dùng (host key, mật khẩu, OTP). Tunnel truyền hàm tự từ chối.
// hooks.onBanner(text), hooks.hostKeyPolicy: 'ask' | 'strict'.
async function connectSsh(target, hooks = {}) {
  let jumpConn = null;
  let sock;
  if (target.jump) {
    jumpConn = await connectSsh(target.jump, { ...hooks, isJumpHop: true });
    try {
      sock = await forwardThrough(jumpConn.client, target.jump, target.host, target.port);
    } catch (e) {
      jumpConn.close();
      throw e;
    }
  }
  // Máy đi qua jump được lưu known host kèm id jump (cùng IP nội bộ sau 2 gateway khác nhau sẽ không lẫn).
  const via = target.jump ? target.jump.id || `${target.jump.host}:${target.jump.port}` : null;
  const hop = target.jump ? `qua ${labelOf(target.jump)}` : null;

  // Thiếu mật khẩu: máy chính trả lỗi để giao diện hỏi (kèm tuỳ chọn lưu); jump host thì hỏi qua giao thức ask.
  if (target.auth === 'password' && !target.password) {
    if (!hooks.isJumpHop) {
      if (jumpConn) jumpConn.close();
      throw codedError(`Cần mật khẩu cho ${labelOf(target)}`, 'need-password');
    }
    if (!hooks.ask || hooks.hostKeyPolicy === 'strict') {
      throw codedError(`Cần mật khẩu cho jump host ${labelOf(target)}. Hãy lưu mật khẩu trong session đó.`, 'need-jump-password');
    }
    const ans = await hooks.ask('secret', { title: `Mật khẩu cho jump host ${labelOf(target)}`, prompts: [{ prompt: 'Mật khẩu', echo: false }], hop: labelOf(target) });
    if (!ans || ans.cancel) throw codedError('Đã huỷ nhập mật khẩu jump host', 'canceled');
    target.password = ans.values[0] || '';
  }

  const config = {
    host: target.host,
    port: target.port,
    username: target.username,
    sock,
    // Đồng hồ handshake do ta tự quản (tạm dừng khi đang chờ người dùng trả lời).
    readyTimeout: 10 * 60_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    tryKeyboard: true,
  };
  if (target.auth === 'key') {
    const keyFile = resolveKeyPath(target.privateKeyPath);
    try {
      config.privateKey = fs.readFileSync(keyFile);
    } catch (e) {
      if (jumpConn) jumpConn.close();
      throw codedError(`Không đọc được private key ${keyFile}: ${e.message}`, 'key-file');
    }
    if (target.passphrase) config.passphrase = target.passphrase;
  }
  if (target.password) config.password = target.password;

  const client = new Client();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(codedError(`Hết thời gian chờ ${target.host}:${target.port} phản hồi`, 'timeout')), HANDSHAKE_MS);
    };
    const pause = () => clearTimeout(timer);
    const close = () => {
      try {
        client.end();
      } catch {}
      if (jumpConn) jumpConn.close();
    };
    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      reject(err);
    }

    config.hostVerifier = (key, verify) => {
      const fp = fingerprint(key);
      const type = keyType(key);
      const known = store.getKnownHost(target.host, target.port, via);
      if (known && known.fingerprint === fp) {
        verify(true);
        return;
      }
      const info = { host: target.host, port: target.port, via, fingerprint: fp, keyType: type, status: known ? 'changed' : 'new', previous: known ? known.fingerprint : null, hop };
      if (hooks.onUnknownHostKey) hooks.onUnknownHostKey(info);
      if (hooks.hostKeyPolicy === 'strict' || !hooks.ask) {
        // Ghi lỗi trước: verify(false) làm ssh2 phát lỗi "Host denied" ngay lập tức.
        fail(codedError(`Host key của ${target.host}:${target.port} chưa được tin tưởng`, 'hostkey-unknown', { hostKey: info }));
        verify(false);
        return;
      }
      pause();
      hooks
        .ask('hostkey', info)
        .then((ans) => {
          if (settled) return;
          arm();
          const ok = Boolean(ans && ans.accept);
          if (ok) store.saveKnownHost(target.host, target.port, fp, type, via);
          verify(ok);
        })
        .catch(() => verify(false));
    };

    // Keyboard-interactive: câu hỏi kiểu "Password" được trả lời bằng mật khẩu đã có;
    // các câu khác (OTP, mã xác thực 2 bước) thì hỏi người dùng.
    let passwordUsed = false;
    client.on('keyboard-interactive', (name, instructions, _lang, prompts, finish) => {
      const answers = prompts.map((p) => {
        if (!passwordUsed && target.password && /pass/i.test(p.prompt)) {
          passwordUsed = true;
          return target.password;
        }
        return null;
      });
      const missing = answers.map((a, i) => (a === null ? i : -1)).filter((i) => i >= 0);
      if (!missing.length) return finish(answers);
      if (!hooks.ask || hooks.hostKeyPolicy === 'strict') return finish(answers.map((a) => a || ''));
      pause();
      hooks
        .ask('prompt', {
          title: name || `Xác thực ${labelOf(target)}`,
          message: instructions || '',
          prompts: missing.map((i) => ({ prompt: prompts[i].prompt.trim(), echo: prompts[i].echo })),
          hop,
        })
        .then((ans) => {
          arm();
          const vals = ans && !ans.cancel ? ans.values : [];
          missing.forEach((i, k) => (answers[i] = vals[k] || ''));
          finish(answers);
        })
        .catch(() => finish(answers.map((a) => a || '')));
    });

    client.on('banner', (text) => hooks.onBanner && hooks.onBanner(text));
    client.once('ready', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ client, close, jump: jumpConn, target });
    });
    client.on('error', (err) => {
      if (!settled) fail(friendlyError(err, target));
    });
    client.on('close', () => {
      if (!settled) fail(codedError(`Mất kết nối tới ${target.host}:${target.port}`, 'closed'));
      // Đóng tầng jump khi kết nối chính kết thúc.
      else if (jumpConn) jumpConn.close();
    });

    arm();
    try {
      client.connect(config);
    } catch (e) {
      fail(friendlyError(e, target));
    }
  });
}

module.exports = { connectSsh, targetFromSession, fingerprint, keyType, labelOf, codedError };
