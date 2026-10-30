'use strict';
// Kênh Server-Sent Events: đẩy trạng thái tunnel, vault, settings, editor ngoài tới mọi cửa sổ đang mở.
const clients = new Set();

function handle(req, res, headers = {}) {
  res.writeHead(200, {
    ...headers,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\nevent: hello\ndata: {}\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

// Bộ nghe trong cùng tiến trình (vd. app Electron đổi màu thanh tiêu đề khi đổi giao diện).
const local = new Map();

function on(type, fn) {
  if (!local.has(type)) local.set(type, new Set());
  local.get(type).add(fn);
}

function emit(type, data = {}) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
  for (const fn of local.get(type) || []) {
    try {
      fn(data);
    } catch {}
  }
}

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25_000).unref();

module.exports = { handle, emit, on };
