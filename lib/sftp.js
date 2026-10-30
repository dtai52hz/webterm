'use strict';
// Các thao tác SFTP dùng cho panel duyệt file (giống sidebar SFTP của MobaXterm).
const posix = require('path').posix;
const crypto = require('crypto');

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

const call = (fn) => new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))));

function entryType(mode) {
  const t = mode & S_IFMT;
  if (t === S_IFDIR) return 'd';
  if (t === S_IFLNK) return 'l';
  return 'f';
}

function permString(mode) {
  const chars = 'rwxrwxrwx';
  let s = '';
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? chars[i] : '-';
  return s;
}

function normalize(p) {
  if (typeof p !== 'string' || !p) throw httpError(400, 'Thiếu đường dẫn');
  if (p.includes('\0')) throw httpError(400, 'Đường dẫn không hợp lệ');
  return p;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function list(sftp, dir) {
  const real = await call((cb) => sftp.realpath(normalize(dir), cb));
  const items = await call((cb) => sftp.readdir(real, cb));
  const entries = await Promise.all(
    items.map(async ({ filename, attrs }) => {
      let type = entryType(attrs.mode);
      let target = null;
      if (type === 'l') {
        // Symlink: xem đích là thư mục hay file để double-click mở đúng.
        try {
          const st = await call((cb) => sftp.stat(posix.join(real, filename), cb));
          target = entryType(st.mode);
        } catch {
          target = 'broken';
        }
      }
      return {
        name: filename,
        type,
        target,
        size: attrs.size,
        mtime: attrs.mtime,
        perms: permString(attrs.mode),
        mode: attrs.mode & 0o7777,
      };
    })
  );
  entries.sort((a, b) => {
    const ad = a.type === 'd' || a.target === 'd';
    const bd = b.type === 'd' || b.target === 'd';
    if (ad !== bd) return ad ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return { path: real, entries };
}

// Tạo nhiều thư mục (tương đối so với base) một lần, như mkdir -p. Dùng khi upload cả thư mục.
async function mkdirs(sftp, base, dirs) {
  normalize(base);
  if (!Array.isArray(dirs) || dirs.length > 10000) throw httpError(400, 'Danh sách thư mục không hợp lệ');
  const want = new Set();
  for (const d of dirs) {
    const rel = posix.normalize(String(d).replace(/\\/g, '/')).replace(/^\/+/, '');
    if (!rel || rel === '.' || rel.startsWith('..') || rel.includes('\0')) throw httpError(400, `Tên thư mục không hợp lệ: ${d}`);
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) want.add(parts.slice(0, i).join('/'));
  }
  // Tạo theo thứ tự cha trước con.
  const ordered = [...want].sort((a, b) => a.split('/').length - b.split('/').length);
  let created = 0;
  for (const rel of ordered) {
    const full = posix.join(base, rel);
    try {
      await call((cb) => sftp.mkdir(full, cb));
      created++;
    } catch (e) {
      let isDir = false;
      try {
        isDir = entryType((await call((cb) => sftp.stat(full, cb))).mode) === 'd';
      } catch {}
      if (!isDir) throw httpError(409, `Không tạo được thư mục ${full}: ${e.message}`);
    }
  }
  return { ok: true, created };
}

// Thay file đích bằng file tạm. Ưu tiên posix-rename@openssh.com (ghi đè nguyên tử).
// Server cũ không hỗ trợ ghi đè: giữ bản cũ dưới tên dự phòng và phục hồi nếu chốt file mới lỗi.
// Tuyệt đối không unlink file đích trước khi biết file mới đã được chốt thành công.
async function replaceFile(sftp, tmp, dest) {
  try {
    await call((cb) => sftp.ext_openssh_rename(tmp, dest, cb));
    return;
  } catch {}
  try {
    await call((cb) => sftp.rename(tmp, dest, cb));
    return;
  } catch {}
  // Nếu đích không tồn tại, lỗi rename không phải do ghi đè: giữ nguyên lỗi và file tạm.
  const st = await call((cb) => sftp.lstat(dest, cb));
  if (entryType(st.mode) === 'd') throw httpError(409, 'Không thể ghi đè thư mục bằng file');
  const saved = posix.join(posix.dirname(dest), `.${posix.basename(dest)}.wtbak-${crypto.randomBytes(12).toString('hex')}`);
  await call((cb) => sftp.rename(dest, saved, cb));
  try {
    await call((cb) => sftp.rename(tmp, dest, cb));
  } catch (e) {
    try {
      await call((cb) => sftp.rename(saved, dest, cb));
    } catch (restoreError) {
      const failure = httpError(500, `Không thay được file và không thể phục hồi về tên cũ. Bản gốc vẫn ở ${saved}: ${restoreError.message}`);
      failure.recoveryPath = saved;
      failure.cause = e;
      throw failure;
    }
    throw e;
  }
  // File mới đã chốt; lỗi dọn bản dự phòng không được báo thành một lần lưu thất bại.
  await call((cb) => sftp.unlink(saved, cb)).catch(() => {});
}

// Dùng chung cho editor trong trình duyệt và editor ngoài: mọi dữ liệu chỉ được ghi vào file tạm.
async function atomicWrite(sftp, p, write) {
  normalize(p);
  let dest = p;
  let mode = null;
  let st;
  try {
    st = await call((cb) => sftp.lstat(p, cb));
  } catch (e) {
    if (e.code !== 2 && e.code !== 'ENOENT') throw e;
  }
  if (st) {
    if (entryType(st.mode) === 'd') throw httpError(409, 'Không thể ghi đè thư mục bằng file');
    // Symlink hỏng phải báo lỗi, không được thay chính symlink bằng file mới.
    if (entryType(st.mode) === 'l') dest = await call((cb) => sftp.realpath(p, cb));
    mode = (await call((cb) => sftp.stat(dest, cb))).mode & 0o7777;
  }
  const tmp = posix.join(posix.dirname(dest), `.${posix.basename(dest)}.wtpart-${crypto.randomBytes(12).toString('hex')}`);
  try {
    await write(tmp, mode);
    if (mode !== null) await call((cb) => sftp.chmod(tmp, mode, cb));
    await replaceFile(sftp, tmp, dest);
    return { ok: true };
  } finally {
    await call((cb) => sftp.unlink(tmp, cb)).catch(() => {});
  }
}

async function removeRecursive(sftp, p) {
  const st = await call((cb) => sftp.lstat(p, cb));
  if (entryType(st.mode) !== 'd') return call((cb) => sftp.unlink(p, cb));
  const items = await call((cb) => sftp.readdir(p, cb));
  for (const { filename } of items) await removeRecursive(sftp, posix.join(p, filename));
  return call((cb) => sftp.rmdir(p, cb));
}

function readStream(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        stream.destroy();
        reject(httpError(413, 'File quá lớn để mở trong trình soạn thảo'));
        return;
      }
      chunks.push(c);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function readText(sftp, p) {
  const st = await call((cb) => sftp.stat(normalize(p), cb));
  if (st.size > MAX_TEXT_BYTES) throw httpError(413, 'File lớn hơn 2 MB, hãy tải về để xem');
  const buf = await readStream(sftp.createReadStream(p), MAX_TEXT_BYTES);
  if (buf.subarray(0, 8000).includes(0)) throw httpError(415, 'File nhị phân, không mở được bằng trình soạn thảo');
  return { path: p, content: buf.toString('utf8'), size: st.size, mtime: st.mtime };
}

function writeText(sftp, p, content) {
  return atomicWrite(sftp, p, (tmp, mode) => new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(tmp, { flags: 'wx', ...(mode !== null ? { mode } : {}) });
    let error;
    ws.on('error', (e) => (error = e));
    ws.on('close', () => error ? reject(error) : resolve());
    ws.end(Buffer.from(String(content), 'utf8'));
  }));
}

async function op(sftp, name, body) {
  switch (name) {
    case 'list':
      return list(sftp, body.path || '.');
    case 'home':
      return { path: await call((cb) => sftp.realpath('.', cb)) };
    case 'stat': {
      const st = await call((cb) => sftp.stat(normalize(body.path), cb));
      return { type: entryType(st.mode), size: st.size, mtime: st.mtime, mode: st.mode & 0o7777 };
    }
    case 'exists':
      try {
        await call((cb) => sftp.stat(normalize(body.path), cb));
        return { exists: true };
      } catch {
        return { exists: false };
      }
    case 'mkdir':
      await call((cb) => sftp.mkdir(normalize(body.path), cb));
      return { ok: true };
    case 'mkdirs':
      return mkdirs(sftp, body.base, body.dirs);
    case 'touch':
      return writeText(sftp, body.path, '');
    case 'rename':
      await call((cb) => sftp.rename(normalize(body.from), normalize(body.to), cb));
      return { ok: true };
    case 'delete': {
      const p = normalize(body.path);
      const canonical = posix.normalize(p).replace(/\/+$/, '') || '/';
      if (['/', '.', '..'].includes(canonical)) throw httpError(400, 'Không cho phép xoá thư mục gốc');
      const st = await call((cb) => sftp.lstat(p, cb));
      if (entryType(st.mode) === 'd' && await call((cb) => sftp.realpath(p, cb)) === '/') {
        throw httpError(400, 'Không cho phép xoá thư mục gốc');
      }
      await removeRecursive(sftp, p);
      return { ok: true };
    }
    case 'chmod': {
      const mode = parseInt(String(body.mode), 8);
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw httpError(400, 'Quyền không hợp lệ (ví dụ 644, 755)');
      await call((cb) => sftp.chmod(normalize(body.path), mode, cb));
      return { ok: true };
    }
    case 'read':
      return readText(sftp, body.path);
    case 'write':
      return writeText(sftp, body.path, body.content ?? '');
    default:
      throw httpError(404, `Thao tác không hỗ trợ: ${name}`);
  }
}

module.exports = { op, call, httpError, replaceFile, atomicWrite };
