'use strict';
// Duyệt cây thư mục trên server qua SFTP để gói zip.
// Chỉ lấy file thường và thư mục: đọc FIFO/thiết bị qua SFTP sẽ treo (vd. khi zip /dev hay /proc), symlink bị bỏ qua.
const posix = require('path').posix;
const { call } = require('./sftp');

const S_IFMT = 0o170000;
const TYPES = { 0o040000: 'dir', 0o100000: 'file', 0o120000: 'symlink', 0o010000: 'fifo', 0o020000: 'chardev', 0o060000: 'blockdev', 0o140000: 'socket' };
const typeOf = (mode) => TYPES[mode & S_IFMT] || 'other';
const MAX_ENTRIES = 200_000;

// Trả về các mục theo thứ tự (cha trước con): {full, rel, type, size, mtime, mode}; skipped: [{path, reason}].
async function* walk(sftp, root, { skipped, isAborted = () => false } = {}) {
  const base = posix.dirname(root.replace(/\/+$/, '') || '/');
  const relOf = (p) => posix.relative(base, p);
  const stack = [root.replace(/\/+$/, '') || '/'];
  let count = 0;
  while (stack.length) {
    if (isAborted()) return;
    const full = stack.pop();
    let st;
    try {
      st = await call((cb) => sftp.lstat(full, cb));
    } catch (e) {
      skipped.push({ path: full, reason: e.message });
      continue;
    }
    const type = typeOf(st.mode);
    if (++count > MAX_ENTRIES) {
      skipped.push({ path: full, reason: `quá ${MAX_ENTRIES} mục, dừng duyệt` });
      return;
    }
    if (type === 'file') {
      yield { full, rel: relOf(full), type, size: st.size, mtime: st.mtime, mode: st.mode & 0o7777 };
    } else if (type === 'dir') {
      yield { full, rel: relOf(full), type, size: 0, mtime: st.mtime, mode: st.mode & 0o7777 };
      let items;
      try {
        items = await call((cb) => sftp.readdir(full, cb));
      } catch (e) {
        skipped.push({ path: full, reason: `không đọc được thư mục: ${e.message}` });
        continue;
      }
      // Đảo ngược để pop() ra theo thứ tự tên tăng dần.
      items.sort((a, b) => b.filename.localeCompare(a.filename));
      for (const it of items) stack.push(posix.join(full, it.filename));
    } else {
      skipped.push({ path: full, reason: type === 'symlink' ? 'symlink (bỏ qua)' : `không phải file thường (${type})` });
    }
  }
}

module.exports = { walk, typeOf };
