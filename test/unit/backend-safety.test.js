'use strict';
// Hồi quy cho dữ liệu client lỗi và các lần lưu SFTP bị gián đoạn; không chạm dữ liệu người dùng.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter, once } = require('events');
const { Writable } = require('stream');
const WebSocket = require('ws');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-safety-test-'));
process.env.WEBTERM_DATA = path.join(tmp, 'data');
process.env.WEBTERM_TOKEN = 'backend-safety-test-token';
const { start, server } = require('../../server');
const { Connection } = require('../../lib/connection');
const { op, replaceFile, atomicWrite } = require('../../lib/sftp');
let origin;

test.before(async () => {
  ({ origin } = await start({ port: 0, host: '127.0.0.1', quiet: true, localFeatures: false }));
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(cookie) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${origin}/api/capabilities`, { headers: { Cookie: cookie } }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
  });
}

test('cookie lỗi bị bỏ qua, không làm sập HTTP hoặc WebSocket server', async () => {
  assert.equal(await request('wt=%'), 401);
  assert.equal(await request('unrelated=%E0%A4%A; wt=backend-safety-test-token'), 200);
  const status = await new Promise((resolve, reject) => {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws/term', {
      headers: { Cookie: 'wt=%', Origin: origin },
    });
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      resolve(res.statusCode);
    });
    ws.once('error', reject);
  });
  assert.equal(status, 403);
  assert.equal(await request('wt=backend-safety-test-token'), 200);
});

test('WebSocket bỏ qua JSON null và primitive, vẫn xử lý frame tiếp theo', async () => {
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws/term', {
    headers: { Cookie: 'wt=backend-safety-test-token', Origin: origin },
  });
  await once(ws, 'open');
  try {
    for (const payload of ['null', 'false', '42', '"text"', '[]', '{']) ws.send(payload);
    const pong = once(ws, 'pong');
    ws.ping();
    await pong;
    assert.equal(await request('wt=backend-safety-test-token'), 200);
  } finally {
    const closed = once(ws, 'close');
    ws.close();
    await closed;
  }
});

test('resize chỉ nhận số nguyên dương và giới hạn kích thước SSH', () => {
  const ws = new EventEmitter();
  ws.OPEN = ws.readyState = 1;
  ws.send = () => {};
  ws.close = () => (ws.readyState = 3);
  const conn = new Connection(ws);
  const windows = [];
  conn.stream = { setWindow: (...args) => windows.push(args) };
  try {
    for (const cols of [null, '80', 0, -1, 1.5, Infinity]) {
      conn.onMessage(Buffer.from(JSON.stringify({ type: 'resize', cols, rows: 24 })), false);
    }
    assert.deepEqual(windows, []);
    conn.onMessage(Buffer.from('{"type":"resize","cols":10000,"rows":10000}'), false);
    assert.deepEqual(windows, [[500, 1000, 0, 0]]);
  } finally {
    conn.dispose();
  }
});

const failure = (message, code = 4) => Object.assign(new Error(message), { code });

// SFTP giả trong bộ nhớ: rename thường không ghi đè, giống server SFTP v3 không có OpenSSH extension.
function remote(initial = {}, { failRename, failWrite = false, extension = false } = {}) {
  const files = new Map(Object.entries(initial).map(([name, data]) => [name, { data, mode: 0o100600 }]));
  const calls = [];
  const find = (p) => {
    if (!files.has(p)) throw failure(`Không có ${p}`, 2);
    return files.get(p);
  };
  const wrap = (fn) => (...args) => {
    const cb = args.pop();
    try {
      cb(null, fn(...args));
    } catch (e) {
      cb(e);
    }
  };
  const sftp = {
    lstat: wrap((p) => ({ ...find(p) })),
    stat: wrap((p) => ({ ...find(p) })),
    realpath: wrap((p) => p),
    chmod: wrap((p, mode) => (find(p).mode = 0o100000 | mode)),
    ext_openssh_rename: wrap((from, to) => {
      calls.push(['atomic', from, to]);
      if (!extension) throw failure('Unsupported', 8);
      const file = find(from);
      files.set(to, file);
      files.delete(from);
    }),
    rename: wrap((from, to) => {
      calls.push(['rename', from, to]);
      const err = failRename && failRename(from, to, calls);
      if (err) throw err;
      const file = find(from);
      if (files.has(to)) throw failure('Destination exists');
      files.set(to, file);
      files.delete(from);
    }),
    unlink: wrap((p) => {
      calls.push(['unlink', p]);
      find(p);
      files.delete(p);
    }),
    createWriteStream(p, options) {
      const chunks = [];
      return new Writable({
        write(chunk, _encoding, cb) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
        final(cb) {
          files.set(p, { data: Buffer.concat(chunks).toString(), mode: 0o100000 | (options.mode ?? 0o644) });
          cb(failWrite ? failure('Connection lost while writing') : null);
        },
      });
    },
  };
  return { sftp, files, calls };
}

test('SFTP: ưu tiên rename nguyên tử, không tạo bản dự phòng nếu server hỗ trợ', async () => {
  const r = remote({ '/file': 'old', '/tmp': 'new' }, { extension: true });
  await replaceFile(r.sftp, '/tmp', '/file');
  assert.equal(r.files.get('/file').data, 'new');
  assert.deepEqual(r.calls, [['atomic', '/tmp', '/file']]);
});

test('SFTP: server cũ ghi đè thành công và dọn file dự phòng', async () => {
  const r = remote({ '/file': 'old', '/tmp': 'new' });
  await replaceFile(r.sftp, '/tmp', '/file');
  assert.equal(r.files.get('/file').data, 'new');
  assert.deepEqual([...r.files.keys()], ['/file']);
  assert.ok(!r.calls.some(([op, p]) => op === 'unlink' && p === '/file'));
});

test('SFTP: rename file mới lỗi thì bản cũ được phục hồi, không unlink bản gốc', async () => {
  const r = remote({ '/file': 'old', '/tmp': 'new' }, {
    failRename: (from, to) => from === '/tmp' && to === '/file' ? failure('Promotion failed') : null,
  });
  await assert.rejects(replaceFile(r.sftp, '/tmp', '/file'), /Promotion failed/);
  assert.equal(r.files.get('/file').data, 'old');
  assert.equal(r.files.get('/tmp').data, 'new');
  assert.ok(!r.calls.some(([op, p]) => op === 'unlink' && p === '/file'));
});

test('SFTP: rollback lỗi vẫn giữ bản gốc và trả đường dẫn phục hồi', async () => {
  const r = remote({ '/file': 'old', '/tmp': 'new' }, {
    failRename: (from, to) => to === '/file' ? failure('Rename unavailable') : null,
  });
  await assert.rejects(replaceFile(r.sftp, '/tmp', '/file'), (e) => {
    assert.match(e.recoveryPath, /\.wtbak-/);
    assert.equal(r.files.get(e.recoveryPath).data, 'old');
    assert.ok(e.message.includes(e.recoveryPath));
    return true;
  });
});

test('SFTP: không di chuyển thư mục khi ghi đè file lỗi', async () => {
  const r = remote({ '/dir': 'directory', '/tmp': 'new' });
  r.files.get('/dir').mode = 0o040755;
  await assert.rejects(replaceFile(r.sftp, '/tmp', '/dir'), (e) => e.status === 409);
  assert.equal(r.files.get('/dir').data, 'directory');
  assert.ok(!r.calls.some(([op]) => op === 'unlink'));
});

test('SFTP: lưu text giữ quyền file và không để lại file tạm', async () => {
  const r = remote({ '/file': 'old' });
  assert.deepEqual(await op(r.sftp, 'write', { path: '/file', content: 'new' }), { ok: true });
  assert.equal(r.files.get('/file').data, 'new');
  assert.equal(r.files.get('/file').mode & 0o7777, 0o600);
  assert.deepEqual([...r.files.keys()], ['/file']);
});

test('SFTP: mất kết nối khi lưu text giữ nguyên file cũ và dọn file tạm', async () => {
  const r = remote({ '/file': 'old' }, { failWrite: true });
  await assert.rejects(op(r.sftp, 'write', { path: '/file', content: 'new' }), /Connection lost/);
  assert.equal(r.files.get('/file').data, 'old');
  assert.deepEqual([...r.files.keys()], ['/file']);
});

test('SFTP: lỗi chốt file sau khi upload giữ nguyên file cũ và dọn file tạm', async () => {
  const r = remote({ '/file': 'old' }, {
    failRename: (from) => from.includes('.wtpart-') ? failure('Commit failed') : null,
  });
  await assert.rejects(op(r.sftp, 'write', { path: '/file', content: 'new' }), /Commit failed/);
  assert.equal(r.files.get('/file').data, 'old');
  assert.deepEqual([...r.files.keys()], ['/file']);
});

test('SFTP: editor ngoài upload lỗi không chạm vào file đích', async () => {
  const r = remote({ '/file': 'old' });
  await assert.rejects(atomicWrite(r.sftp, '/file', async (tmpPath) => {
    r.files.set(tmpPath, { data: 'partial', mode: 0o100600 });
    throw failure('fastPut failed');
  }), /fastPut failed/);
  assert.equal(r.files.get('/file').data, 'old');
  assert.deepEqual([...r.files.keys()], ['/file']);
});

test('SFTP: lưu qua symlink cập nhật đích và giữ nguyên symlink', async () => {
  const r = remote({ '/link': 'symlink', '/target': 'old' });
  r.files.get('/link').mode = 0o120777;
  r.sftp.realpath = (_p, cb) => cb(null, '/target');
  await op(r.sftp, 'write', { path: '/link', content: 'new' });
  assert.equal(r.files.get('/link').mode, 0o120777);
  assert.equal(r.files.get('/target').data, 'new');
  assert.equal(r.files.size, 2);
});

test('SFTP: symlink hỏng được giữ nguyên khi lưu lỗi', async () => {
  const r = remote({ '/link': 'symlink' });
  r.files.get('/link').mode = 0o120777;
  r.sftp.realpath = (_p, cb) => cb(failure('Broken symlink', 2));
  await assert.rejects(op(r.sftp, 'write', { path: '/link', content: 'new' }), /Broken symlink/);
  assert.equal(r.files.get('/link').mode, 0o120777);
  assert.equal(r.files.size, 1);
  assert.deepEqual(r.calls, []);
});

test('SFTP: rollback lỗi vẫn dọn phần upload dở và giữ file phục hồi', async () => {
  const r = remote({ '/file': 'old' }, {
    failRename: (_from, to) => to === '/file' ? failure('Rename unavailable') : null,
  });
  await assert.rejects(op(r.sftp, 'write', { path: '/file', content: 'new' }), (e) => {
    assert.equal(r.files.get(e.recoveryPath).data, 'old');
    assert.deepEqual([...r.files.keys()], [e.recoveryPath]);
    return true;
  });
});

test('SFTP: chặn các cách viết khác của root/current/parent trước khi xoá', async () => {
  for (const p of ['/', '//', '/./', '/tmp/..', '.', './', 'foo/..', '..', '../']) {
    const r = remote();
    await assert.rejects(op(r.sftp, 'delete', { path: p }), (e) => e.status === 400, p);
    assert.deepEqual(r.calls, []);
  }
  const r = remote({ '/root-alias/child/..': 'directory' });
  r.files.get('/root-alias/child/..').mode = 0o040755;
  r.sftp.realpath = (_p, cb) => cb(null, '/');
  await assert.rejects(op(r.sftp, 'delete', { path: '/root-alias/child/..' }), (e) => e.status === 400);
  assert.equal(r.files.size, 1);
});
