'use strict';
// Test Phase 1: cài đặt (kiểm tra, lưu bền, phát SSE), macro CRUD, lệnh khi đăng nhập, ghi chú,
// session RDP/local, và đồng hồ handshake tạm dừng khi đang chờ người dùng xác nhận host key.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { tmpDir, startProc, stopProc, client, suite, sleep } = require('./helpers');

const WT_PORT = 3398;
const SSH_PORT = 2298;
const TOKEN = 'test-token-terminal';
const TMP = tmpDir('webterm-terminal-');
const DATA = path.join(TMP, 'data');
const t = suite('Terminal: cài đặt, macro, lệnh khi đăng nhập');
const { authed, openTerminal, openEvents } = client({ port: WT_PORT, token: TOKEN });
const wtEnv = { PORT: WT_PORT, WEBTERM_TOKEN: TOKEN, WEBTERM_DATA: DATA, WEBTERM_HANDSHAKE_MS: '1500' };

t.onCleanup(() => fs.rmSync(TMP, { recursive: true, force: true }));

t.run(async () => {
  await startProc('test/fake-sshd.js', { FAKE_SSHD_PORT: SSH_PORT, FAKE_SSHD_ROOT: path.join(TMP, 'sshd') });
  let wt = await startProc('server.js', wtEnv);

  await t.step('Cài đặt: mặc định hợp lệ, giá trị sai bị chặn/điều chỉnh, đổi là phát qua SSE', async () => {
    const def = await authed('GET', '/api/settings');
    assert.strictEqual(def.json.theme, 'webterm');
    assert.strictEqual(def.json.highlight, true);
    const ev = await openEvents();
    const r = await authed('PUT', '/api/settings', { body: { theme: 'dracula', fontSize: 99, cursorStyle: 'weird', scrollback: 10, highlight: false, fontFamily: 'Consolas;}</style>' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.theme, 'dracula');
    assert.strictEqual(r.json.fontSize, 28, 'cỡ chữ bị giới hạn tối đa 28');
    assert.strictEqual(r.json.cursorStyle, 'block');
    assert.strictEqual(r.json.scrollback, 500);
    assert.strictEqual(r.json.highlight, false);
    assert.ok(!/[;{}<>]/.test(r.json.fontFamily), 'font không chứa ký tự CSS nguy hiểm');
    const pushed = await ev.waitFor('settings');
    assert.strictEqual(pushed.theme, 'dracula');
    ev.close();
    const bad = await authed('PUT', '/api/settings', { body: { externalEditor: 'C:\\evil.bat' } });
    assert.strictEqual(bad.status, process.platform === 'win32' ? 400 : 200);
  });

  await t.step('Cài đặt được giữ sau khi khởi động lại server', async () => {
    await stopProc(wt);
    wt = await startProc('server.js', wtEnv);
    const r = await authed('GET', '/api/settings');
    assert.strictEqual(r.json.theme, 'dracula');
    assert.strictEqual(r.json.highlight, false);
  });

  await t.step('Macro: tạo, sửa, liệt kê, xoá; dữ liệu sai bị từ chối', async () => {
    assert.strictEqual((await authed('POST', '/api/macros', { body: { name: '', kind: 'text', text: 'ls' } })).status, 400);
    assert.strictEqual((await authed('POST', '/api/macros', { body: { name: 'Rỗng', kind: 'text', text: '   ' } })).status, 400);
    const a = await authed('POST', '/api/macros', { body: { name: 'Cập nhật', folder: 'Ubuntu', kind: 'text', text: 'apt update\r\napt -y upgrade', delay: 99999 } });
    assert.strictEqual(a.status, 201);
    assert.strictEqual(a.json.text, 'apt update\napt -y upgrade', 'CRLF được chuẩn hoá');
    assert.strictEqual(a.json.delay, 10000);
    assert.strictEqual(a.json.enter, true);
    const k = await authed('POST', '/api/macros', { body: { name: 'Phím', kind: 'keys', keys: 'top\r\x1b[Aq' } });
    assert.strictEqual(k.json.keys, 'top\r\x1b[Aq');
    const upd = await authed('PUT', `/api/macros/${a.json.id}`, { body: { name: 'Cập nhật hệ thống', enter: false } });
    assert.strictEqual(upd.json.name, 'Cập nhật hệ thống');
    assert.strictEqual(upd.json.enter, false);
    assert.strictEqual(upd.json.text, 'apt update\napt -y upgrade');
    const list = await authed('GET', '/api/macros');
    assert.deepStrictEqual(list.json.map((m) => m.name).sort(), ['Cập nhật hệ thống', 'Phím']);
    assert.strictEqual((await authed('DELETE', `/api/macros/${k.json.id}`)).status, 200);
    assert.strictEqual((await authed('DELETE', `/api/macros/${k.json.id}`)).status, 404);
  });

  let ssh;
  await t.step('Session SSH: ghi chú giữ xuống dòng, lệnh khi đăng nhập chạy sau khi vào shell', async () => {
    const r = await authed('POST', '/api/sessions', {
      body: { name: 'Có lệnh', host: '127.0.0.1', port: SSH_PORT, username: 'test', password: 'secret', notes: 'dòng 1\r\ndòng 2', loginCommand: 'cd /home\necho login-ok', startDir: '/home/test' },
    });
    ssh = r.json;
    assert.strictEqual(ssh.notes, 'dòng 1\ndòng 2');
    assert.strictEqual(ssh.loginCommand, 'cd /home\necho login-ok');
    const term = await openTerminal({ sessionId: ssh.id });
    await term.waitMsg('ready');
    await term.waitFor(() => term.output.includes('login-ok\r\n'), 'lệnh khi đăng nhập đã chạy');
    term.send('pwd\r');
    await term.waitFor(() => /pwd\r\n\/home\r\n/.test(term.output), 'cd trong lệnh đăng nhập có tác dụng (sau cd startDir)');
    await term.close();
  });

  await t.step('Session RDP và terminal local: kiểu và trường riêng được kiểm tra đúng', async () => {
    const rdp = await authed('POST', '/api/sessions', { body: { type: 'rdp', host: '10.0.0.9', username: 'Administrator', password: 'p@ss', rdpAuth: 'credman', rdpFullscreen: true } });
    assert.strictEqual(rdp.status, 201);
    assert.deepStrictEqual([rdp.json.type, rdp.json.port, rdp.json.rdpAuth, rdp.json.rdpFullscreen, rdp.json.hasPassword], ['rdp', 3389, 'credman', true, true]);
    assert.strictEqual(rdp.json.loginCommand, undefined);
    const local = await authed('POST', '/api/sessions', { body: { type: 'local', name: 'Máy tôi', shell: 'cmd', host: 'bỏ qua' } });
    assert.strictEqual(local.status, 201);
    assert.deepStrictEqual([local.json.type, local.json.shell, local.json.host], ['local', 'cmd', undefined]);
    // Đổi kiểu SSH -> RDP: bỏ các trường chỉ dành cho SSH.
    const changed = await authed('PUT', `/api/sessions/${ssh.id}`, { body: { type: 'rdp', port: 3389 } });
    assert.deepStrictEqual([changed.json.type, changed.json.loginCommand, changed.json.auth], ['rdp', undefined, undefined]);
    await authed('PUT', `/api/sessions/${ssh.id}`, { body: { type: 'ssh', port: SSH_PORT } });
  });

  await t.step('Chờ xác nhận host key lâu hơn thời gian handshake vẫn kết nối được', async () => {
    await authed('DELETE', `/api/known-hosts/${encodeURIComponent(`127.0.0.1:${SSH_PORT}`)}`);
    // Thời gian handshake trong test là 1,5 s; trả lời host key sau 3 s.
    const term = await openTerminal({ sessionId: ssh.id }, { manualHostKey: true });
    const ask = await term.waitFor(() => term.asks.find((a) => a.kind === 'hostkey'), 'câu hỏi host key');
    await sleep(3000);
    term.control({ type: 'answer', id: ask.id, accept: true });
    await term.waitMsg('ready', 5000);
    await term.close();
  });

  await t.step('Không trả lời host key thì bị huỷ khi tab đóng, không treo server', async () => {
    await authed('DELETE', `/api/known-hosts/${encodeURIComponent(`127.0.0.1:${SSH_PORT}`)}`);
    const term = await openTerminal({ sessionId: ssh.id }, { manualHostKey: true });
    await term.waitFor(() => term.asks.find((a) => a.kind === 'hostkey'), 'câu hỏi host key');
    await term.close();
    await sleep(300);
    const again = await openTerminal({ sessionId: ssh.id });
    await again.waitMsg('ready');
    await again.close();
  });
});
