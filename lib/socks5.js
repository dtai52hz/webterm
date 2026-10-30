'use strict';
// Proxy SOCKS5 tối giản cho tunnel -D: không xác thực, chỉ lệnh CONNECT.
// Tên miền (ATYP 3) được chuyển nguyên cho server SSH phân giải (DNS phía server, giống ssh -D).

const REPLY = { ok: 0, fail: 1, refused: 5, cmdNotSupported: 7, atypNotSupported: 8 };

function ipv6(buf) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(i).toString(16));
  return parts.join(':');
}

// Phân tích dữ liệu đã nhận. Trả về null nếu chưa đủ byte (TCP có thể cắt gói bất kỳ chỗ nào).
function parseGreeting(buf) {
  if (buf.length < 2) return null;
  if (buf[0] !== 5) return { error: 'version' };
  const n = buf[1];
  if (buf.length < 2 + n) return null;
  return { methods: [...buf.subarray(2, 2 + n)], used: 2 + n };
}

function parseRequest(buf) {
  if (buf.length < 4) return null;
  if (buf[0] !== 5) return { error: 'version' };
  const cmd = buf[1];
  const atyp = buf[3];
  let host;
  let end;
  if (atyp === 1) {
    end = 4 + 4;
    if (buf.length < end + 2) return null;
    host = [...buf.subarray(4, 8)].join('.');
  } else if (atyp === 3) {
    if (buf.length < 5) return null;
    end = 5 + buf[4];
    if (buf.length < end + 2) return null;
    host = buf.subarray(5, end).toString('utf8');
  } else if (atyp === 4) {
    end = 4 + 16;
    if (buf.length < end + 2) return null;
    host = ipv6(buf.subarray(4, end));
  } else {
    return { error: 'atyp' };
  }
  return { cmd, atyp, host, port: buf.readUInt16BE(end), used: end + 2 };
}

const reply = (code) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

// connect(host, port) => Promise<Duplex> (kênh SSH forwardOut).
function handleSocks(sock, connect, onPipe) {
  let buf = Buffer.alloc(0);
  let stage = 'greeting';
  sock.setNoDelay(true);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 4096) return sock.destroy();
    if (stage === 'greeting') {
      const g = parseGreeting(buf);
      if (!g) return;
      if (g.error) return sock.destroy();
      buf = buf.subarray(g.used);
      if (!g.methods.includes(0)) return sock.end(Buffer.from([5, 0xff]));
      sock.write(Buffer.from([5, 0]));
      stage = 'request';
    }
    if (stage === 'request') {
      const r = parseRequest(buf);
      if (!r) return;
      sock.removeListener('data', onData);
      stage = 'connecting';
      if (r.error) return sock.end(reply(r.error === 'atyp' ? REPLY.atypNotSupported : REPLY.fail));
      if (r.cmd !== 1) return sock.end(reply(REPLY.cmdNotSupported)); // BIND / UDP ASSOCIATE không hỗ trợ
      const rest = buf.subarray(r.used);
      sock.pause();
      connect(r.host, r.port)
        .then((stream) => {
          sock.write(reply(REPLY.ok));
          if (rest.length) stream.write(rest);
          if (onPipe) onPipe(sock, stream);
          else {
            sock.pipe(stream).pipe(sock);
            stream.on('close', () => sock.destroy());
            sock.on('close', () => stream.destroy());
          }
          sock.resume();
        })
        .catch(() => sock.end(reply(REPLY.refused)));
    }
  };
  sock.on('data', onData);
  sock.on('error', () => {});
}

module.exports = { handleSocks, parseGreeting, parseRequest, REPLY };
