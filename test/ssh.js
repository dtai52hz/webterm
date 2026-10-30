'use strict';
// Test Phase 2: jump host (hỏi host key từng tầng, hỏi mật khẩu jump, chặn forwarding), OTP 2 bước,
// SSH tunnel -L/-D/-R, tin tưởng host key cho tunnel, tự chạy sau khi khởi động lại, tự nối lại khi server SSH restart.
const fs = require('fs');
const net = require('net');
const path = require('path');
const assert = require('assert');
const { tmpDir, startProc, stopProc, client, suite, echoServer, freePort, sleep, waitUntil } = require('./helpers');

const WT_PORT = 3397;
const GW_PORT = 2301; // gateway (jump host)
const IN_PORT = 2302; // server nội bộ chỉ vào được qua gateway
const DENY_PORT = 2303; // gateway cấm chuyển tiếp
const TOKEN = 'test-token-ssh';
const TMP = tmpDir('webterm-ssh-');
const DATA = path.join(TMP, 'data');
const t = suite('SSH: jump host, OTP, tunnel');
const { authed, openTerminal } = client({ port: WT_PORT, token: TOKEN });
const wtEnv = { PORT: WT_PORT, WEBTERM_TOKEN: TOKEN, WEBTERM_DATA: DATA };
const sshd = (port, extra = {}) => startProc('test/fake-sshd.js', { FAKE_SSHD_PORT: port, FAKE_SSHD_ROOT: path.join(TMP, `sshd-${port}`), ...extra });

t.onCleanup(() => fs.rmSync(TMP, { recursive: true, force: true }));

function connectTcp(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

function echoRoundTrip(sock, text) {
  return new Promise((resolve, reject) => {
    let got = '';
    const timer = setTimeout(() => reject(new Error(`Không nhận được echo "${text}"`)), 5000);
    sock.on('data', (d) => {
      got += d;
      if (got.includes(text)) {
        clearTimeout(timer);
        resolve(got);
      }
    });
    sock.write(text);
  });
}

// Bắt tay SOCKS5 thủ công (gửi từng mảnh nhỏ để kiểm tra server đệm dữ liệu đúng).
async function socksConnect(proxyPort, { host, port, atyp }) {
  const s = await connectTcp(proxyPort);
  const read = (n) =>
    new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const onData = (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length >= n) {
          s.removeListener('data', onData);
          resolve(buf);
        }
      };
      s.on('data', onData);
      setTimeout(() => reject(new Error('SOCKS không trả lời')), 5000);
    });
  s.write(Buffer.from([5]));
  await sleep(20);
  s.write(Buffer.from([1, 0]));
  const hello = await read(2);
  assert.deepStrictEqual([...hello.subarray(0, 2)], [5, 0]);
  let addr;
  if (atyp === 1) addr = Buffer.from([1, ...host.split('.').map(Number)]);
  else addr = Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)]);
  const req = Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([port >> 8, port & 255])]);
  s.write(req.subarray(0, 3));
  await sleep(20);
  s.write(req.subarray(3));
  const rep = await read(10);
  assert.strictEqual(rep[1], 0, `SOCKS reply code ${rep[1]}`);
  return s;
}

const tunnelStatus = async (id) => (await authed('GET', '/api/tunnels')).json.find((x) => x.id === id);
const waitStatus = (id, status, ms = 12000) => waitUntil(async () => (await tunnelStatus(id)).status === status && tunnelStatus(id), `tunnel ${status}`, ms, 200);

t.run(async () => {
  let gw = await sshd(GW_PORT);
  await sshd(IN_PORT);
  await sshd(DENY_PORT, { FAKE_SSHD_DENY_TCPIP: '1' });
  let wt = await startProc('server.js', wtEnv);
  const echo = await echoServer();
  const ECHO = echo.address().port;
  t.onCleanup(() => echo.close());

  const mk = async (body) => {
    const r = await authed('POST', '/api/sessions', { body });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    return r.json;
  };
  const gateway = await mk({ name: 'Gateway', host: '127.0.0.1', port: GW_PORT, username: 'test', password: 'secret' });
  const inner = await mk({ name: 'Nội bộ', host: '127.0.0.1', port: IN_PORT, username: 'test', password: 'secret', jumpSessionId: gateway.id });

  await t.step('Jump host: hỏi host key từng tầng (có ghi rõ tầng), rồi vào được server nội bộ', async () => {
    const term = await openTerminal({ sessionId: inner.id });
    await term.waitMsg('ready');
    const hk = term.asks.filter((a) => a.kind === 'hostkey');
    assert.strictEqual(hk.length, 2);
    assert.deepStrictEqual([hk[0].port, hk[0].hop], [GW_PORT, null]);
    assert.strictEqual(hk[1].port, IN_PORT);
    assert.match(hk[1].hop, /qua test@127\.0\.0\.1:2301/);
    term.send('whoami\r');
    await term.waitFor(() => /whoami\r\ntest\r\n/.test(term.output), 'whoami qua jump');
    assert.match(gw.output, new RegExp(`TCPIP 127\\.0\\.0\\.1:${IN_PORT}`), 'gateway đã mở kênh direct-tcpip tới máy nội bộ');
    const kh = (await authed('GET', '/api/known-hosts')).json;
    assert.ok(kh[`127.0.0.1:${IN_PORT}@${gateway.id}`], 'known host của máy nội bộ lưu kèm id jump');
    await term.close();
  });

  await t.step('Jump host chưa lưu mật khẩu: hỏi qua giao thức ask rồi kết nối được', async () => {
    const gw2 = await mk({ name: 'Gateway không mật khẩu', host: '127.0.0.1', port: GW_PORT, username: 'test' });
    const target = await mk({ name: 'Qua gw2', host: '127.0.0.1', port: IN_PORT, username: 'test', password: 'secret', jumpSessionId: gw2.id });
    const term = await openTerminal({ sessionId: target.id }, { answers: (a) => (a.kind === 'secret' ? ['secret'] : null) });
    await term.waitMsg('ready');
    const secret = term.asks.find((a) => a.kind === 'secret');
    assert.ok(secret && secret.hop, 'đã hỏi mật khẩu jump host');
    await term.close();
  });

  await t.step('Jump host cấm chuyển tiếp: báo lỗi dễ hiểu', async () => {
    const deny = await mk({ name: 'Cấm', host: '127.0.0.1', port: DENY_PORT, username: 'test', password: 'secret' });
    const target = await mk({ name: 'Qua cấm', host: '127.0.0.1', port: IN_PORT, username: 'test', password: 'secret', jumpSessionId: deny.id });
    const term = await openTerminal({ sessionId: target.id });
    const err = await term.waitMsg('error');
    assert.strictEqual(err.code, 'jump-forward');
    assert.match(err.message, /không (cho chuyển tiếp|mở được kết nối)/);
  });

  await t.step('Jump host: chặn vòng lặp và không cho xoá session đang làm gateway', async () => {
    const loop = await authed('PUT', `/api/sessions/${gateway.id}`, { body: { jumpSessionId: inner.id } });
    assert.strictEqual(loop.status, 400);
    assert.match(loop.json.error, /vòng lặp/);
    const del = await authed('DELETE', `/api/sessions/${gateway.id}`);
    assert.strictEqual(del.status, 409);
  });

  await t.step('Xác thực 2 bước (OTP): mật khẩu tự điền, chỉ hỏi mã; sai mã thì báo lỗi', async () => {
    const ok = await openTerminal({ host: '127.0.0.1', port: GW_PORT, username: 'otp', password: 'secret' }, { answers: (a) => (a.kind === 'prompt' ? ['123456'] : null) });
    await ok.waitMsg('ready');
    const p = ok.asks.find((a) => a.kind === 'prompt');
    assert.deepStrictEqual(p.prompts.map((x) => x.prompt), ['Verification code:'], 'chỉ hỏi mã OTP, mật khẩu đã tự trả lời');
    await ok.close();
    const bad = await openTerminal({ host: '127.0.0.1', port: GW_PORT, username: 'otp', password: 'secret' }, { answers: () => ['000000'] });
    assert.strictEqual((await bad.waitMsg('error')).code, 'auth');
  });

  let tl;
  await t.step('Tunnel -L: cổng local tới echo server qua SSH', async () => {
    const port = await freePort();
    const r = await authed('POST', '/api/tunnels', { body: { name: 'L echo', type: 'L', sessionId: gateway.id, bindHost: '127.0.0.1', bindPort: port, destHost: '127.0.0.1', destPort: ECHO } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    tl = r.json;
    await authed('POST', `/api/tunnels/${tl.id}/start`);
    await waitStatus(tl.id, 'running');
    const s = await connectTcp(port);
    await echoRoundTrip(s, 'xin-chao-L');
    s.destroy();
  });

  await t.step('Tunnel -D: SOCKS5 với địa chỉ IPv4 và tên miền, gói bị cắt nhỏ', async () => {
    const port = await freePort();
    const r = await authed('POST', '/api/tunnels', { body: { type: 'D', sessionId: gateway.id, bindPort: port } });
    assert.match(r.json.name, /SOCKS/);
    await authed('POST', `/api/tunnels/${r.json.id}/start`);
    await waitStatus(r.json.id, 'running');
    const a = await socksConnect(port, { atyp: 1, host: '127.0.0.1', port: ECHO });
    await echoRoundTrip(a, 'qua-socks-ip');
    a.destroy();
    const b = await socksConnect(port, { atyp: 3, host: 'localhost', port: ECHO });
    await echoRoundTrip(b, 'qua-socks-dns');
    b.destroy();
    await authed('POST', `/api/tunnels/${r.json.id}/stop`);
  });

  await t.step('Tunnel -R: cổng trên server dẫn ngược về echo server phía máy này', async () => {
    const port = await freePort();
    const r = await authed('POST', '/api/tunnels', { body: { type: 'R', sessionId: gateway.id, bindHost: '127.0.0.1', bindPort: port, destHost: '127.0.0.1', destPort: ECHO } });
    await authed('POST', `/api/tunnels/${r.json.id}/start`);
    await waitStatus(r.json.id, 'running');
    await waitUntil(() => gw.output.includes(`FORWARD 127.0.0.1:${port}`), 'server đã mở cổng -R');
    const s = await connectTcp(port);
    await echoRoundTrip(s, 'nguoc-ve-R');
    s.destroy();
    await authed('POST', `/api/tunnels/${r.json.id}/stop`);
  });

  await t.step('Dừng tunnel thì cổng được giải phóng; xoá session đang có tunnel bị chặn', async () => {
    const port = (await tunnelStatus(tl.id)).bindPort;
    await authed('POST', `/api/tunnels/${tl.id}/stop`);
    assert.strictEqual((await tunnelStatus(tl.id)).status, 'stopped');
    await assert.rejects(connectTcp(port), /ECONNREFUSED/);
    const solo = await mk({ name: 'Solo', host: '127.0.0.1', port: GW_PORT, username: 'test', password: 'secret' });
    const tt = await authed('POST', '/api/tunnels', { body: { type: 'D', sessionId: solo.id, bindPort: await freePort() } });
    const del = await authed('DELETE', `/api/sessions/${solo.id}`);
    assert.strictEqual(del.status, 409);
    assert.match(del.json.error, /tunnel/);
    await authed('DELETE', `/api/tunnels/${tt.json.id}`);
  });

  await t.step('Host key lạ: tunnel dừng chờ xác nhận, chỉ tin đúng fingerprint server đã thấy', async () => {
    const fresh = await sshd(2304);
    t.onCleanup(() => stopProc(fresh));
    const s = await mk({ name: 'Server mới', host: '127.0.0.1', port: 2304, username: 'test', password: 'secret' });
    const r = await authed('POST', '/api/tunnels', { body: { type: 'D', sessionId: s.id, bindPort: await freePort() } });
    await authed('POST', `/api/tunnels/${r.json.id}/start`);
    const st = await waitStatus(r.json.id, 'error');
    assert.strictEqual(st.errorCode, 'hostkey-unknown');
    assert.match(st.hostKey.fingerprint, /^SHA256:/);
    const wrong = await authed('POST', '/api/known-hosts/trust', { body: { ...st.hostKey, fingerprint: 'SHA256:gia-mao' } });
    assert.strictEqual(wrong.status, 400);
    const right = await authed('POST', '/api/known-hosts/trust', { body: st.hostKey });
    assert.strictEqual(right.status, 200);
    await authed('POST', `/api/tunnels/${r.json.id}/start`);
    await waitStatus(r.json.id, 'running');
    await authed('POST', `/api/tunnels/${r.json.id}/stop`);
  });

  await t.step('Tunnel bật "tự chạy" chạy lại sau khi khởi động lại WebTerm', async () => {
    await authed('PUT', `/api/tunnels/${tl.id}`, { body: { autoStart: true } });
    await stopProc(wt);
    wt = await startProc('server.js', wtEnv);
    await waitStatus(tl.id, 'running');
    const s = await connectTcp((await tunnelStatus(tl.id)).bindPort);
    await echoRoundTrip(s, 'sau-khi-restart');
    s.destroy();
  });

  await t.step('Server SSH khởi động lại: tunnel tự nối lại, cổng local vẫn mở', async () => {
    await stopProc(gw);
    await waitStatus(tl.id, 'reconnecting');
    gw = await sshd(GW_PORT);
    await waitStatus(tl.id, 'running', 20000);
    const s = await connectTcp((await tunnelStatus(tl.id)).bindPort);
    await echoRoundTrip(s, 'da-noi-lai');
    s.destroy();
  });
});
