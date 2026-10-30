'use strict';
// Kiểm soát các tính năng chạm vào máy local (shell local, RDP, editor ngoài, lưu key vào ~/.ssh).

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Request phải đi thẳng từ chính máy này: địa chỉ loopback và không qua reverse proxy.
function isLocalReq(req) {
  const h = req.headers;
  if (h['x-forwarded-for'] || h.forwarded || h['x-real-ip']) return false;
  return LOOPBACK_ADDRS.has(req.socket.remoteAddress);
}

// Biến môi trường cho process con: bỏ token và biến nội bộ của WebTerm/Electron/npm, cả biến của launcher
// bản Portable (để app khác mở từ terminal không tưởng mình cũng đang chạy từ USB).
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(WEBTERM_|ELECTRON_|npm_|PORTABLE_EXECUTABLE_)/i.test(k) || /^(NODE_OPTIONS|NODE_CHANNEL_FD|NODE_UNIQUE_ID)$/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

class LocalOnlyError extends Error {
  constructor() {
    super('Tính năng này chỉ dùng được trên chính máy đang chạy WebTerm');
    this.status = 403;
    this.code = 'local-only';
  }
}

module.exports = { isLocalReq, cleanEnv, LocalOnlyError };
