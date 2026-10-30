'use strict';
// Thư mục SSH key và cách hiểu đường dẫn private key ghi trong session.
const os = require('os');
const path = require('path');

// Bản chạy từ USB đặt WEBTERM_SSH_DIR = WebTerm-data\keys để key đi theo USB.
const sshDir = () => process.env.WEBTERM_SSH_DIR || path.join(os.homedir(), '.ssh');

// Đường dẫn tương đối được tính từ thư mục key: session ghi "id_ed25519" dùng được trên mọi máy,
// và khi chạy từ USB thì không phụ thuộc USB đang mang ký tự ổ nào (E:, F:...). "~" là thư mục home.
function resolveKeyPath(p) {
  if (!p) return p;
  if (/^~(?=$|[\\/])/.test(p)) return path.join(os.homedir(), p.slice(1));
  return path.isAbsolute(p) ? p : path.join(sshDir(), p);
}

module.exports = { sshDir, resolveKeyPath };
