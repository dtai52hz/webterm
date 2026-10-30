// Hàng đợi upload: chạy 2 file song song, mỗi file có thanh tiến trình và nút huỷ.
import { $, el, toast } from './core/dom.js';
import { api } from './core/api.js';
import { choiceDialog, confirmDialog } from './core/dialogs.js';
import { fmtBytes, joinPath } from './core/format.js';
import { icon } from './core/icons.js';
import { bus } from './state.js';

const MAX_PARALLEL = 2;
const queue = [];
let running = 0;
let jobSeq = 0;
const pendingByTab = new Map(); // tab.key -> số job chưa xong (để làm mới danh sách khi xong hết)
const STATUS_ICON = { queued: 'clock', running: 'upload', done: 'check', skipped: 'arrow-right', canceled: 'x', error: 'alert' };

function render(job) {
  if (!job.el) {
    job.bar = el('i');
    job.iconBox = el('span', { class: 'transfer-icon' });
    job.label = el('span', { class: 'transfer-name' });
    job.cancelBtn = el('button', { class: 'icon-btn transfer-cancel', title: 'Huỷ', 'aria-label': 'Huỷ', onclick: () => cancel(job) }, icon('x'));
    job.el = el('div', { class: 'transfer' }, el('div', { class: 'transfer-head' }, job.iconBox, job.label, job.cancelBtn), el('div', { class: 'bar' }, job.bar));
    $('#sftp-transfers').append(job.el);
  }
  if (job.shownStatus !== job.status) {
    job.iconBox.replaceChildren(icon(STATUS_ICON[job.status]));
    job.shownStatus = job.status;
  }
  const pct = job.size ? Math.min(100, (job.loaded / job.size) * 100) : job.status === 'done' ? 100 : 0;
  job.bar.style.width = `${pct}%`;
  const speed = job.speed ? ` · ${fmtBytes(job.speed)}/s` : '';
  const text = {
    queued: `${job.name} · đang chờ`,
    running: `${job.name} · ${pct.toFixed(0)}%${speed}`,
    done: `${job.name} (${fmtBytes(job.size)})`,
    skipped: `${job.name} · bỏ qua (đã có)`,
    canceled: `${job.name} · đã huỷ`,
    error: `${job.name}: ${job.error}`,
  }[job.status];
  job.label.textContent = text;
  job.label.title = job.dest;
  job.el.className = `transfer ${job.status}`;
  job.cancelBtn.hidden = !['queued', 'running'].includes(job.status);
}

function finish(job, status, error) {
  job.status = status;
  job.error = error;
  render(job);
  setTimeout(() => job.el && job.el.remove(), status === 'error' ? 10_000 : 3000);
  const left = (pendingByTab.get(job.tab.key) || 1) - 1;
  pendingByTab.set(job.tab.key, left);
  if (left <= 0) bus.emit('sftp-refresh', job.tab);
}

function cancel(job) {
  if (job.status === 'queued') {
    queue.splice(queue.indexOf(job), 1);
    finish(job, 'canceled');
  } else if (job.xhr) job.xhr.abort();
}

async function run(job) {
  if (job.tab.status !== 'connected') return finish(job, 'error', 'mất kết nối');
  if (job.conflict === 'skip') {
    try {
      if ((await api('POST', `/api/sftp/${job.tab.connId}/exists`, { path: job.dest })).exists) return finish(job, 'skipped');
    } catch {}
  }
  job.status = 'running';
  render(job);
  await new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    job.xhr = xhr;
    const started = Date.now();
    xhr.open('PUT', `/api/sftp/${job.tab.connId}/upload?path=${encodeURIComponent(job.dest)}`);
    xhr.upload.onprogress = (e) => {
      job.loaded = e.loaded;
      job.speed = e.loaded / Math.max(0.5, (Date.now() - started) / 1000);
      render(job);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) finish(job, 'done');
      else {
        let msg = `HTTP ${xhr.status}`;
        try {
          msg = JSON.parse(xhr.responseText).error || msg;
        } catch {}
        finish(job, 'error', msg);
      }
      resolve();
    };
    xhr.onerror = () => (finish(job, 'error', 'mất kết nối'), resolve());
    xhr.onabort = () => (finish(job, 'canceled'), resolve());
    xhr.send(job.file);
  });
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    running++;
    run(job).finally(() => {
      running--;
      pump();
    });
  }
}

// items: [{file, relPath}] — relPath dùng '/' (vd. "thu-muc/con/a.txt").
// existingNames: tên đang có trong thư mục đích (để hỏi ghi đè một lần). extraDirs: thư mục rỗng cần tạo.
export async function uploadItems(tab, items, destDir, existingNames = [], extraDirs = []) {
  if (!items.length && !extraDirs.length) return;
  const dirs = [...new Set([...extraDirs, ...items.map((it) => it.relPath.split('/').slice(0, -1).join('/'))].filter(Boolean))];
  const topNames = new Set([...items.map((it) => it.relPath.split('/')[0]), ...extraDirs.map((d) => d.split('/')[0])]);
  const clashes = [...topNames].filter((n) => existingNames.includes(n));
  let conflict = 'overwrite';
  if (clashes.length) {
    const shown = clashes.slice(0, 5).join(', ') + (clashes.length > 5 ? `… (+${clashes.length - 5})` : '');
    if (items.length === 1) {
      if (!(await confirmDialog('Ghi đè?', `${joinPath(destDir, clashes[0])} đã tồn tại trên server. Ghi đè?`, 'Ghi đè', true))) return;
    } else {
      conflict = await choiceDialog('Đã có file trùng tên', `Trong thư mục đích đã có: ${shown}`, [
        { value: 'overwrite', label: 'Ghi đè tất cả', danger: true },
        { value: 'skip', label: 'Bỏ qua file đã có' },
        { value: 'cancel', label: 'Huỷ' },
      ]);
      if (!conflict) return;
    }
  }
  if (dirs.length) {
    try {
      await api('POST', `/api/sftp/${tab.connId}/mkdirs`, { base: destDir, dirs });
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    if (!items.length) return bus.emit('sftp-refresh', tab);
  }
  pendingByTab.set(tab.key, (pendingByTab.get(tab.key) || 0) + items.length);
  for (const it of items) {
    const job = { id: ++jobSeq, tab, file: it.file, name: it.relPath, dest: joinPath(destDir, it.relPath), size: it.file.size, loaded: 0, status: 'queued', conflict };
    render(job);
    queue.push(job);
  }
  pump();
}

// Đọc toàn bộ file và thư mục được kéo thả (FileSystemEntry API).
export async function collectEntries(entries) {
  const items = [];
  const dirs = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      items.push({ file, relPath: prefix + entry.name });
    } else if (entry.isDirectory) {
      dirs.push(prefix + entry.name);
      const reader = entry.createReader();
      // Chromium trả tối đa 100 mục mỗi lần, phải đọc tới khi rỗng.
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return { items, dirs };
}
