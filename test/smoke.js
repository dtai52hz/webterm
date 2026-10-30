'use strict';
// Test end-to-end cơ bản: chạy WebTerm + fake-sshd trên cổng riêng, kiểm tra bảo mật (token, Origin, Host),
// session API, terminal qua WebSocket, SFTP, giám sát và import MobaXterm.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { tmpDir, startProc, client, suite, sleep } = require('./helpers');

const WT_PORT = 3399;
const SSH_PORT = 2299;
const TOKEN = 'test-token-123';
const TMP = tmpDir('webterm-test-');
const t = suite('Smoke test');
const { origin: ORIGIN, cookie: COOKIE, request, authed, openTerminal, openEvents } = client({ port: WT_PORT, token: TOKEN });

t.onCleanup(() => fs.rmSync(TMP, { recursive: true, force: true }));

t.run(async () => {
  await startProc('test/fake-sshd.js', { FAKE_SSHD_PORT: SSH_PORT, FAKE_SSHD_ROOT: path.join(TMP, 'sshd') });
  await startProc('server.js', { PORT: WT_PORT, WEBTERM_TOKEN: TOKEN, WEBTERM_DATA: path.join(TMP, 'data') });

  await t.step('Trang chủ, module giao diện và thư viện xterm được phục vụ', async () => {
    const home = await request('GET', '/');
    assert.strictEqual(home.status, 200);
    assert.match(home.headers['content-security-policy'], /script-src 'self'/);
    assert.match(home.buf.toString(), /type="module" src="\/js\/main.js"/);
    for (const p of ['/js/main.js', '/js/term/tab.js', '/js/core/dialogs.js', '/app.css', '/vendor/xterm.js', '/vendor/xterm.css', '/vendor/addon-fit.js', '/vendor/addon-web-links.js']) {
      const r = await request('GET', p);
      assert.strictEqual(r.status, 200, p);
    }
    assert.match((await request('GET', '/js/main.js')).headers['content-type'], /text\/javascript/);
    assert.strictEqual((await request('GET', '/app.js')).status, 404);
    assert.strictEqual((await request('GET', '/../server.js')).status, 404);
    assert.strictEqual((await request('GET', '/%2e%2e/server.js')).status, 404);
  });

  await t.step('Chặn truy cập khi chưa có token / token sai / Origin lạ / Host lạ', async () => {
    assert.strictEqual((await request('GET', '/api/sessions')).status, 401);
    assert.strictEqual((await request('GET', '/?token=sai')).status, 403);
    const login = await request('GET', `/?token=${TOKEN}`);
    assert.strictEqual(login.status, 302);
    assert.match(login.headers['set-cookie'][0], /wt=.*HttpOnly; SameSite=Strict/);
    assert.strictEqual((await request('POST', '/api/sessions', { body: { host: 'x' }, headers: { Cookie: COOKIE } })).status, 403, 'POST thiếu Origin');
    assert.strictEqual((await request('POST', '/api/sessions', { body: { host: 'x' }, headers: { Cookie: COOKIE, Origin: 'http://evil.com' } })).status, 403);
    assert.strictEqual((await request('GET', '/api/sessions', { headers: { Cookie: COOKIE, Host: 'evil.com' } })).status, 421);
    await assert.rejects(openTerminal({}, { headers: { Cookie: COOKIE, Origin: 'http://evil.com' } }), (e) => e.status === 403);
    await assert.rejects(openTerminal({}, { headers: { Origin: ORIGIN } }), (e) => e.status === 403);
  });

  await t.step('Capabilities: tính năng local chỉ bật khi request đi thẳng từ máy này', async () => {
    const direct = await authed('GET', '/api/capabilities');
    assert.strictEqual(direct.status, 200);
    assert.strictEqual(direct.json.localFeatures, true);
    assert.strictEqual(direct.json.platform, process.platform);
    for (const h of ['X-Forwarded-For', 'Forwarded', 'X-Real-IP']) {
      const proxied = await authed('GET', '/api/capabilities', { headers: { [h]: '203.0.113.9' } });
      assert.strictEqual(proxied.json.localFeatures, false, h);
    }
  });

  await t.step('Kênh sự kiện SSE gửi hello', async () => {
    const ev = await openEvents();
    assert.strictEqual(ev.status, 200);
    await ev.waitFor('hello');
    ev.close();
  });

  let session;
  await t.step('Tạo session, mật khẩu không bị trả về trình duyệt và được mã hoá trên đĩa', async () => {
    const r = await authed('POST', '/api/sessions', { body: { name: 'Fake VPS', folder: 'Test/Local', host: '127.0.0.1', port: SSH_PORT, username: 'test', password: 'secret' } });
    assert.strictEqual(r.status, 201);
    session = r.json;
    assert.strictEqual(session.hasPassword, true);
    assert.strictEqual(session.type, 'ssh');
    assert.strictEqual(session.password, undefined);
    const onDisk = fs.readFileSync(path.join(TMP, 'data', 'sessions.json'), 'utf8');
    assert.ok(!onDisk.includes('secret'), 'mật khẩu không được lưu dạng rõ');
    assert.strictEqual((await authed('POST', '/api/sessions', { body: { host: 'bad host!' } })).status, 400);
  });

  let term;
  await t.step('Kết nối lần đầu: hỏi host key, rồi vào được shell', async () => {
    term = await openTerminal({ sessionId: session.id });
    const ready = await term.waitMsg('ready');
    assert.strictEqual(term.hostkeyPrompts, 1);
    assert.strictEqual(ready.username, 'test');
    term.connId = ready.id;
    await term.waitFor(() => term.output.includes('$ '), 'prompt');
    term.send('whoami\r');
    await term.waitFor(() => /whoami\r\ntest\r\n/.test(term.output), 'whoami');
  });

  await t.step('Paste dài (> 1 MB khi gửi theo khúc 64 KB) không làm đứt phiên', async () => {
    const chunk = Buffer.alloc(64 * 1024, 'a');
    for (let i = 0; i < 20; i++) term.ws.send(chunk);
    term.send('\x03');
    term.send('echo con-song\r');
    await term.waitFor(() => term.output.includes('con-song\r\n'), 'phiên còn sống sau paste dài', 15000);
  });

  await t.step('Giám sát server: nhận CPU/RAM/Disk/mạng', async () => {
    term.control({ type: 'monitor', enabled: true });
    const first = await term.waitMsg('stats');
    assert.ok(first.memTotal > 0 && first.diskTotal > 0 && first.load.length === 3);
    const second = await term.waitMsg('stats', 8000);
    assert.ok(second.cpu >= 0 && second.cpu <= 100, `cpu=${second.cpu}`);
    assert.ok(second.rxRate > 0, 'rxRate');
    term.control({ type: 'monitor', enabled: false });
  });

  await t.step('SFTP: liệt kê, tạo thư mục, upload, đọc, sửa, đổi tên, chmod, tải về, xoá', async () => {
    const sftp = (op, body) => authed('POST', `/api/sftp/${term.connId}/${op}`, { body });
    const home = await sftp('list', { path: '.' });
    assert.strictEqual(home.status, 200);
    assert.strictEqual(home.json.path, '/home/test');
    assert.ok(home.json.entries.some((e) => e.name === 'welcome.txt'));

    assert.strictEqual((await sftp('mkdir', { path: '/home/test/demo' })).status, 200);
    const content = Buffer.from('xin chào WebTerm 👋\nline 2\n', 'utf8');
    const up = await authed('PUT', `/api/sftp/${term.connId}/upload?path=${encodeURIComponent('/home/test/demo/hello.txt')}`, { raw: content });
    assert.strictEqual(up.status, 200, JSON.stringify(up.json));

    const read = await sftp('read', { path: '/home/test/demo/hello.txt' });
    assert.strictEqual(read.json.content, content.toString('utf8'));
    await sftp('write', { path: '/home/test/demo/hello.txt', content: 'đã sửa\n' });
    assert.strictEqual((await sftp('read', { path: '/home/test/demo/hello.txt' })).json.content, 'đã sửa\n');

    assert.strictEqual((await sftp('rename', { from: '/home/test/demo/hello.txt', to: '/home/test/demo/xin-chao.txt' })).status, 200);
    assert.strictEqual((await sftp('chmod', { path: '/home/test/demo/xin-chao.txt', mode: '600' })).status, 200);
    const listed = await sftp('list', { path: '/home/test/demo' });
    const entry = listed.json.entries.find((e) => e.name === 'xin-chao.txt');
    assert.strictEqual(entry.perms, 'rw-------');

    const dl = await authed('GET', `/api/sftp/${term.connId}/download?path=${encodeURIComponent('/home/test/demo/xin-chao.txt')}`);
    assert.strictEqual(dl.status, 200);
    assert.strictEqual(dl.buf.toString('utf8'), 'đã sửa\n');
    assert.match(dl.headers['content-disposition'], /filename\*=UTF-8''xin-chao\.txt/);

    const bin = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1, 2]);
    await authed('PUT', `/api/sftp/${term.connId}/upload?path=${encodeURIComponent('/home/test/demo/app.bin')}`, { raw: bin });
    assert.strictEqual((await sftp('read', { path: '/home/test/demo/app.bin' })).status, 415, 'file nhị phân bị từ chối mở');

    const mk = await sftp('mkdirs', { base: '/home/test/demo', dirs: ['a/b/c', 'a/d', 'e'] });
    assert.strictEqual(mk.status, 200, JSON.stringify(mk.json));
    assert.strictEqual((await sftp('stat', { path: '/home/test/demo/a/b/c' })).json.type, 'd');
    assert.strictEqual((await sftp('mkdirs', { base: '/home/test/demo', dirs: ['../../../etc'] })).status, 400, 'mkdirs không cho thoát khỏi base');

    assert.strictEqual((await sftp('delete', { path: '/' })).status, 400, 'không cho xoá /');
    assert.strictEqual((await sftp('delete', { path: '/home/test/demo' })).status, 200);
    assert.strictEqual((await sftp('exists', { path: '/home/test/demo' })).json.exists, false);

    term.send('ls\r');
    await term.waitFor(() => term.output.includes('welcome.txt'), 'ls thấy file');
  });

  await t.step('Kết nối lần hai: host key đã được tin tưởng, không hỏi lại', async () => {
    const t2 = await openTerminal({ sessionId: session.id });
    await t2.waitMsg('ready');
    assert.strictEqual(t2.hostkeyPrompts, 0);
    t2.send('hostname\r');
    await t2.waitFor(() => t2.output.includes('fake-vps\r\n'), 'hostname');
    await t2.close();
  });

  await t.step('Sai mật khẩu báo lỗi auth; từ chối host key thì không kết nối', async () => {
    const bad = await openTerminal({ host: '127.0.0.1', port: SSH_PORT, username: 'test', password: 'sai' });
    const err = await bad.waitMsg('error');
    assert.strictEqual(err.code, 'auth');
    const noPass = await openTerminal({ host: '127.0.0.1', port: SSH_PORT, username: 'test' });
    assert.strictEqual((await noPass.waitMsg('error')).code, 'need-password');
    const kh = await authed('DELETE', `/api/known-hosts/${encodeURIComponent(`127.0.0.1:${SSH_PORT}`)}`);
    assert.strictEqual(kh.status, 200);
    const rejected = await openTerminal({ sessionId: session.id }, { acceptHostKey: false });
    await rejected.waitMsg('error');
    assert.ok(!rejected.messages.some((m) => m.type === 'ready'));
  });

  await t.step('Đóng WebSocket thì kết nối SSH và SFTP bị huỷ', async () => {
    const id = term.connId;
    await term.close();
    await sleep(300);
    assert.strictEqual((await authed('POST', `/api/sftp/${id}/list`, { body: { path: '.' } })).status, 404);
  });

  await t.step('Import MobaXterm.ini: đọc thư mục, port, user, bỏ qua session không phải SSH và session trùng', async () => {
    const ini = [
      '[Bookmarks]',
      'SubRep=',
      'ImgNum=42',
      'VPS Sing=#109#0%10.0.0.5%22%root%%-1%-1%%%%%0%-1%0%%%-1%0%0%0',
      'Windows box=#91#4%10.0.0.9%3389%admin%0%-1',
      '[Bookmarks_1]',
      'SubRep=Khach hang\\Thang 10',
      'ImgNum=41',
      'Web__PIPE__01=#109#0%web.example.com%2222%%%-1%-1%%%%%0%-1%0%_ProfileDir_\\.ssh\\id_rsa.ppk%%-1%0%0%0',
    ].join('\r\n');
    const preview = await authed('POST', '/api/import/mobaxterm', { body: { preview: true, content: ini } });
    assert.strictEqual(preview.json.sessions.length, 2);
    const [a, b] = preview.json.sessions;
    assert.deepStrictEqual([a.name, a.host, a.port, a.username, a.folder, a.auth], ['VPS Sing', '10.0.0.5', 22, 'root', '', 'password']);
    assert.deepStrictEqual([b.name, b.host, b.port, b.folder, b.auth], ['Web|01', 'web.example.com', 2222, 'Khach hang/Thang 10', 'key']);
    assert.ok(b.privateKeyPath.endsWith('.ssh\\id_rsa.ppk'));
    const first = await authed('POST', '/api/import/mobaxterm', { body: { content: ini } });
    assert.deepStrictEqual([first.json.added, first.json.skipped], [2, 0]);
    const again = await authed('POST', '/api/import/mobaxterm', { body: { content: ini } });
    assert.deepStrictEqual([again.json.added, again.json.skipped], [0, 2]);
  });

  await t.step('Sửa và xoá session', async () => {
    const upd = await authed('PUT', `/api/sessions/${session.id}`, { body: { name: 'Đổi tên', password: '' } });
    assert.strictEqual(upd.json.name, 'Đổi tên');
    assert.strictEqual(upd.json.hasPassword, false);
    assert.strictEqual((await authed('DELETE', `/api/sessions/${session.id}`)).status, 200);
    const list = await authed('GET', '/api/sessions');
    assert.ok(!list.json.some((s) => s.id === session.id));
  });
});
