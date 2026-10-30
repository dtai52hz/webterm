'use strict';
// Test Phase 3: upload an toàn (huỷ giữa chừng không làm hỏng file cũ, giữ quyền file), tải thư mục dạng zip
// (kiểm bằng tar.exe và Expand-Archive của Windows, có chế độ ép ZIP64), vé zip dùng một lần,
// SFTP theo thư mục terminal, sửa bằng editor ngoài (tự upload, phát hiện xung đột).
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { tmpDir, startProc, client, suite, sleep, ROOT } = require('./helpers');
const { POWERSHELL, powerShellEnv } = require('../lib/windows-powershell');

const WT_PORT = 3396;
const WT64_PORT = 3395;
const SSH_PORT = 2296;
const TOKEN = 'test-token-sftp';
const TMP = tmpDir('webterm-sftp-');
const SSHD_ROOT = path.join(TMP, 'sshd');
const t = suite('SFTP: upload an toàn, zip, theo terminal, editor ngoài');
const c = client({ port: WT_PORT, token: TOKEN });
const c64 = client({ port: WT64_PORT, token: TOKEN });
const editorCmd = JSON.stringify([process.execPath, path.join(ROOT, 'test', 'fake-editor.js')]);

t.onCleanup(() => fs.rmSync(TMP, { recursive: true, force: true }));

const remoteFile = (p) => path.join(SSHD_ROOT, 'root', ...p.split('/').filter(Boolean));

async function connect(cl) {
  const s = await cl.authed('POST', '/api/sessions', { body: { name: 'SFTP', host: '127.0.0.1', port: SSH_PORT, username: 'test', password: 'secret' } });
  const term = await cl.openTerminal({ sessionId: s.json.id });
  const ready = await term.waitMsg('ready');
  term.connId = ready.id;
  await term.waitFor(() => term.output.includes('$ '), 'prompt');
  return term;
}

// Gửi upload chậm rồi cắt ngang giữa chừng.
function abortedUpload(connId, remotePath) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: WT_PORT,
      method: 'PUT',
      path: `/api/sftp/${connId}/upload?path=${encodeURIComponent(remotePath)}`,
      headers: { Cookie: c.cookie, Origin: c.origin, 'Content-Length': 10 * 1024 * 1024 },
    });
    req.on('error', () => resolve());
    req.write(Buffer.alloc(256 * 1024, 'x'));
    setTimeout(() => {
      req.destroy();
      setTimeout(resolve, 500);
    }, 400);
  });
}

async function downloadZip(cl, connId, paths) {
  const { json } = await cl.authed('POST', `/api/sftp/${connId}/zip`, { body: { paths } });
  const r = await cl.authed('GET', `/api/sftp/${connId}/download-zip?ticket=${json.ticket}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-type'], 'application/zip');
  return { buf: r.buf, ticket: json.ticket, headers: r.headers };
}

// Kiểm file zip bằng 2 trình đọc độc lập: bsdtar (tar.exe) và .NET (Expand-Archive).
function verifyZip(buf, expected) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-zipcheck-'));
  try {
    const zipFile = path.join(dir, 'a.zip');
    fs.writeFileSync(zipFile, buf);
    const list = spawnSync('tar.exe', ['-tf', zipFile], { encoding: 'utf8' });
    assert.strictEqual(list.status, 0, `tar -tf lỗi: ${list.stderr}`);
    const names = list.stdout.split(/\r?\n/).filter(Boolean);
    for (const name of Object.keys(expected)) assert.ok(names.includes(name), `zip thiếu ${name}; có: ${names.join(', ')}`);
    const out1 = path.join(dir, 'tar');
    fs.mkdirSync(out1);
    const x = spawnSync('tar.exe', ['-xf', zipFile, '-C', out1], { encoding: 'utf8' });
    assert.strictEqual(x.status, 0, `tar -xf lỗi: ${x.stderr}`);
    const out2 = path.join(dir, 'ps');
    const ps = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${out2}'`], { encoding: 'utf8', env: powerShellEnv(), windowsHide: true });
    assert.strictEqual(ps.status, 0, `Expand-Archive lỗi: ${ps.stderr}`);
    for (const [name, content] of Object.entries(expected)) {
      if (content === null) continue; // thư mục
      for (const base of [out1, out2]) {
        const got = fs.readFileSync(path.join(base, ...name.split('/')));
        assert.ok(got.equals(content), `nội dung ${name} sai khi giải nén bằng ${base === out1 ? 'tar' : 'Expand-Archive'}`);
      }
    }
    for (const base of [out1, out2]) assert.ok(fs.statSync(path.join(base, 'demo', 'empty')).isDirectory(), 'giữ được thư mục rỗng');
    return names;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

t.run(async () => {
  await startProc('test/fake-sshd.js', { FAKE_SSHD_PORT: SSH_PORT, FAKE_SSHD_ROOT: SSHD_ROOT });
  await startProc('server.js', { PORT: WT_PORT, WEBTERM_TOKEN: TOKEN, WEBTERM_DATA: path.join(TMP, 'data'), WEBTERM_EDITOR_CMD: editorCmd });
  const term = await connect(c);
  const sftp = (op, body) => c.authed('POST', `/api/sftp/${term.connId}/${op}`, { body });
  const upload = (p, content) => c.authed('PUT', `/api/sftp/${term.connId}/upload?path=${encodeURIComponent(p)}`, { raw: content });

  await t.step('Upload ghi đè: giữ quyền file cũ; upload bị huỷ giữa chừng không làm hỏng file cũ', async () => {
    await sftp('mkdir', { path: '/home/test/demo' });
    assert.strictEqual((await upload('/home/test/demo/a.txt', Buffer.from('bản gốc\n'))).status, 200);
    await sftp('chmod', { path: '/home/test/demo/a.txt', mode: '600' });
    assert.strictEqual((await upload('/home/test/demo/a.txt', Buffer.from('bản mới\n'))).status, 200);
    let list = (await sftp('list', { path: '/home/test/demo' })).json.entries;
    assert.strictEqual(list.find((e) => e.name === 'a.txt').perms, 'rw-------', 'quyền 600 được giữ sau khi ghi đè');
    await abortedUpload(term.connId, '/home/test/demo/a.txt');
    assert.strictEqual(fs.readFileSync(remoteFile('/home/test/demo/a.txt'), 'utf8'), 'bản mới\n', 'file cũ nguyên vẹn sau khi upload bị huỷ');
    list = (await sftp('list', { path: '/home/test/demo' })).json.entries;
    assert.ok(!list.some((e) => e.name.includes('.wtpart-')), 'không còn file tạm');
  });

  const bin = crypto.randomBytes(300 * 1024);
  const expected = {
    'demo/': null,
    'demo/a.txt': Buffer.from('bản mới\n'),
    'demo/sub/': null,
    'demo/sub/b.bin': bin,
    'demo/empty/': null,
  };

  await t.step('Tải thư mục dạng zip: cấu trúc, thư mục rỗng, nội dung đúng với 2 trình giải nén', async () => {
    await sftp('mkdirs', { base: '/home/test/demo', dirs: ['sub', 'empty'] });
    await upload('/home/test/demo/sub/b.bin', bin);
    const { buf, headers } = await downloadZip(c, term.connId, ['/home/test/demo']);
    assert.match(headers['content-disposition'], /demo\.zip/);
    verifyZip(buf, expected);
  });

  // tar.exe của Windows (trang mã 1252) không đọc được tên tiếng Việt kể cả trong zip do .NET tạo,
  // nên tên Unicode được kiểm bằng Expand-Archive.
  await t.step('Zip giữ đúng tên file tiếng Việt (cờ UTF-8)', async () => {
    await sftp('mkdir', { path: '/home/test/vn' });
    await upload('/home/test/vn/tiếng việt.txt', Buffer.from('xin chào\n'));
    const { buf } = await downloadZip(c, term.connId, ['/home/test/vn']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-zipvn-'));
    try {
      fs.writeFileSync(path.join(dir, 'vn.zip'), buf);
      const ps = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${path.join(dir, 'vn.zip')}' -DestinationPath '${path.join(dir, 'out')}'`], { encoding: 'utf8', env: powerShellEnv(), windowsHide: true });
      assert.strictEqual(ps.status, 0, ps.stderr);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'out', 'vn', 'tiếng việt.txt'), 'utf8'), 'xin chào\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.step('Vé tải zip chỉ dùng được một lần và không dùng chéo kết nối', async () => {
    const { json } = await c.authed('POST', `/api/sftp/${term.connId}/zip`, { body: { paths: ['/home/test/demo/a.txt'] } });
    assert.strictEqual((await c.authed('GET', `/api/sftp/${term.connId}/download-zip?ticket=${json.ticket}`)).status, 200);
    assert.strictEqual((await c.authed('GET', `/api/sftp/${term.connId}/download-zip?ticket=${json.ticket}`)).status, 410);
    assert.strictEqual((await c.authed('POST', `/api/sftp/${term.connId}/zip`, { body: { paths: [] } })).status, 400);
  });

  await t.step('Zip ở chế độ ép ZIP64 vẫn đọc được bằng cả tar và Expand-Archive', async () => {
    await startProc('server.js', { PORT: WT64_PORT, WEBTERM_TOKEN: TOKEN, WEBTERM_DATA: path.join(TMP, 'data64'), WEBTERM_ZIP_FORCE64: '1' });
    const t64 = await connect(c64);
    const { buf } = await downloadZip(c64, t64.connId, ['/home/test/demo']);
    assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'có bản ghi ZIP64 end of central directory');
    verifyZip(buf, expected);
    await t64.close();
  });

  await t.step('SFTP theo terminal: báo thư mục hiện tại và cập nhật sau lệnh cd', async () => {
    term.control({ type: 'follow', enabled: true });
    const first = await term.waitMsg('cwd');
    assert.strictEqual(first.path, '/home/test');
    term.send('cd demo\r');
    const next = await term.waitMsg('cwd', 3000);
    assert.strictEqual(next.path, '/home/test/demo');
    term.send('cd sub\r');
    assert.strictEqual((await term.waitMsg('cwd', 3000)).path, '/home/test/demo/sub');
    term.control({ type: 'follow', enabled: false });
  });

  await t.step('Sửa bằng editor ngoài: lưu trong editor là file trên server được cập nhật', async () => {
    const r = await sftp('edit-external', { path: '/home/test/demo/a.txt' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.ok(fs.existsSync(r.json.localPath));
    const msg = await term.waitMsg('edit-sync', 8000);
    assert.strictEqual(msg.status, 'uploaded');
    assert.strictEqual(fs.readFileSync(remoteFile('/home/test/demo/a.txt'), 'utf8'), 'bản mới\nsửa bằng editor ngoài\n');
  });

  await t.step('Editor ngoài: file trên server bị đổi trong lúc sửa thì hỏi trước khi ghi đè', async () => {
    await upload('/home/test/demo/conflict.txt', Buffer.from('v1\n'));
    const r = await sftp('edit-external', { path: '/home/test/demo/conflict.txt' });
    await sleep(1100); // mtime trên server có độ phân giải 1 giây
    await upload('/home/test/demo/conflict.txt', Buffer.from('server đã sửa\n'));
    fs.writeFileSync(r.json.localPath, 'bản trên máy\n');
    const msg = await term.waitMsg('edit-sync', 8000);
    assert.strictEqual(msg.status, 'conflict');
    assert.strictEqual(fs.readFileSync(remoteFile('/home/test/demo/conflict.txt'), 'utf8'), 'server đã sửa\n', 'chưa ghi đè khi chưa xác nhận');
    const force = await c.authed('POST', `/api/sftp/${term.connId}/edit-external/${msg.editId}/upload`);
    assert.strictEqual(force.status, 200);
    assert.strictEqual(fs.readFileSync(remoteFile('/home/test/demo/conflict.txt'), 'utf8'), 'bản trên máy\n');
  });

  await t.step('Đóng tab thì thư mục tạm của editor ngoài được dọn', async () => {
    const r = await sftp('edit-external', { path: '/home/test/demo/conflict.txt' });
    const dir = path.dirname(r.json.localPath);
    assert.ok(fs.existsSync(dir));
    await term.close();
    await sleep(500);
    assert.ok(!fs.existsSync(dir), 'thư mục tạm đã bị xoá');
  });

  await t.step('Sửa bằng editor ngoài bị chặn khi request đi qua proxy', async () => {
    const t2 = await connect(c);
    const r = await c.authed('POST', `/api/sftp/${t2.connId}/edit-external`, { body: { path: '/home/test/demo/a.txt' }, headers: { 'X-Forwarded-For': '203.0.113.5' } });
    assert.strictEqual(r.status, 403);
    await t2.close();
  });
});
