'use strict';
// Sửa file trên server bằng editor trên máy (Notepad++, VS Code, Notepad...), lưu là tự upload lại.
// Mỗi lần sửa có một thư mục tạm riêng; theo dõi cả thư mục vì nhiều editor lưu bằng cách ghi file mới rồi thay thế.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const posix = path.posix;
const { call, httpError, atomicWrite } = require('./sftp');
const { cleanEnv } = require('./guard');
const settings = require('./settings');

// Mỗi tiến trình WebTerm có thư mục riêng, để bản web và bản app chạy cùng lúc không dọn nhầm của nhau.
const BASE = path.join(os.tmpdir(), 'webterm-edit');
const ROOT = path.join(BASE, String(process.pid));
const MAX_SIZE = 50 * 1024 * 1024;
const DEBOUNCE_MS = 700;
const edits = new Map();

function detectEditors() {
  if (process.platform !== 'win32') return [];
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    { id: 'vscode', name: 'Visual Studio Code', paths: [path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'), path.join(pf, 'Microsoft VS Code', 'Code.exe')] },
    { id: 'notepadpp', name: 'Notepad++', paths: [path.join(pf, 'Notepad++', 'notepad++.exe'), path.join(pf86, 'Notepad++', 'notepad++.exe')] },
    { id: 'sublime', name: 'Sublime Text', paths: [path.join(pf, 'Sublime Text', 'sublime_text.exe'), path.join(pf, 'Sublime Text 3', 'sublime_text.exe')] },
    { id: 'notepad', name: 'Notepad', paths: [path.join(sys, 'System32', 'notepad.exe')] },
  ];
  return candidates.map((c) => ({ id: c.id, name: c.name, path: c.paths.find((p) => fs.existsSync(p)) })).filter((c) => c.path);
}

// Lệnh mở editor: [file, ...args]. WEBTERM_EDITOR_CMD (JSON) chỉ dùng cho test tự động.
function editorCommand() {
  if (process.env.WEBTERM_EDITOR_CMD) return JSON.parse(process.env.WEBTERM_EDITOR_CMD);
  const chosen = settings.get().externalEditor;
  if (chosen && fs.existsSync(chosen)) return [chosen];
  const found = detectEditors()[0];
  if (!found) throw httpError(500, 'Không tìm thấy editor nào trên máy. Chọn file .exe trong Cài đặt → Công cụ.');
  return [found.path];
}

// Giữ đuôi file (để editor tô màu đúng), bỏ ký tự Windows không cho phép.
function localName(remotePath) {
  const base = posix.basename(remotePath) || 'file';
  return base.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '_').slice(0, 120) || 'file';
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function remoteInfo(sftp, p) {
  return call((cb) => sftp.stat(p, cb)).then((st) => ({ size: st.size, mtime: st.mtime, mode: st.mode }));
}

async function upload(e, { force = false } = {}) {
  const conn = e.conn;
  if (conn.closed) return;
  const sftp = await conn.getSftp();
  // Đợi editor ghi xong: kích thước không đổi trong 200 ms.
  let size = -1;
  for (let i = 0; i < 10; i++) {
    const s = fs.existsSync(e.local) ? fs.statSync(e.local).size : -1;
    if (s === size) break;
    size = s;
    await sleep(200);
  }
  if (size < 0) return;
  const hash = sha256(e.local);
  if (hash === e.lastHash && !force) return;
  if (!force) {
    const now = await remoteInfo(sftp, e.remote).catch(() => null);
    if (now && (now.mtime !== e.remoteState.mtime || now.size !== e.remoteState.size)) {
      e.pendingHash = hash;
      conn.send({ type: 'edit-sync', status: 'conflict', editId: e.id, path: e.remote });
      return;
    }
  }
  await atomicWrite(sftp, e.remote, (tmp) => call((cb) => sftp.fastPut(e.local, tmp, cb)));
  e.lastHash = hash;
  e.remoteState = await remoteInfo(sftp, e.remote);
  conn.send({ type: 'edit-sync', status: 'uploaded', editId: e.id, path: e.remote, size });
}

function schedule(e) {
  clearTimeout(e.timer);
  e.timer = setTimeout(() => {
    e.queue = e.queue
      .then(() => upload(e))
      .catch((err) => e.conn.send({ type: 'edit-sync', status: 'error', editId: e.id, path: e.remote, message: err.message }));
  }, DEBOUNCE_MS);
}

function cleanup(id) {
  const e = edits.get(id);
  if (!e) return;
  edits.delete(id);
  clearTimeout(e.timer);
  try {
    e.watcher.close();
  } catch {}
  fs.rm(e.dir, { recursive: true, force: true }, () => {});
}

async function openRemote(conn, remotePath) {
  const sftp = await conn.getSftp();
  const st = await call((cb) => sftp.stat(remotePath, cb));
  if ((st.mode & 0o170000) !== 0o100000) throw httpError(400, 'Chỉ mở được file thường');
  if (st.size > MAX_SIZE) throw httpError(413, 'File lớn hơn 50 MB');
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(ROOT, conn.id, id);
  fs.mkdirSync(dir, { recursive: true });
  const local = path.join(dir, localName(remotePath));
  await call((cb) => sftp.fastGet(remotePath, local, cb));
  const e = {
    id,
    conn,
    dir,
    local,
    remote: remotePath,
    lastHash: sha256(local),
    remoteState: { size: st.size, mtime: st.mtime },
    queue: Promise.resolve(),
    timer: null,
  };
  e.watcher = fs.watch(dir, (_evt, fname) => {
    if (!fname || fname === path.basename(local)) schedule(e);
  });
  edits.set(id, e);
  conn.disposers.push(() => cleanup(id));

  const [file, ...args] = editorCommand();
  const child = spawn(file, [...args, local], { detached: true, stdio: 'ignore', env: cleanEnv(), windowsHide: false });
  child.on('error', (err) => conn.send({ type: 'edit-sync', status: 'error', editId: id, path: remotePath, message: `Không mở được editor: ${err.message}` }));
  child.unref();
  return { editId: id, localPath: local, editor: path.basename(file) };
}

// Người dùng chọn ghi đè dù file trên server đã bị thay đổi.
async function forceUpload(connId, editId) {
  const e = edits.get(editId);
  if (!e || e.conn.id !== connId) throw httpError(404, 'Phiên sửa file đã kết thúc');
  e.queue = e.queue.then(() => upload(e, { force: true }));
  await e.queue;
  return { ok: true };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// Xoá thư mục tạm còn sót của các lần chạy trước (tiến trình đã thoát).
function cleanupStale() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(BASE);
  } catch {
    return;
  }
  for (const d of dirs) {
    const pid = Number(d);
    if (!pid || pid === process.pid || !alive(pid)) fs.rm(path.join(BASE, d), { recursive: true, force: true }, () => {});
  }
}

module.exports = { detectEditors, openRemote, forceUpload, cleanupStale };
