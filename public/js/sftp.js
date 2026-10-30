// Panel SFTP theo tab đang chọn (giống sidebar SFTP của MobaXterm): chọn nhiều file, kéo thả upload,
// tải về (nhiều file thì gói zip), đổi tên, chmod, xoá, sửa file.
import { $, $$, el, toast, copyText } from './core/dom.js';
import { api } from './core/api.js';
import { promptDialog, confirmDialog } from './core/dialogs.js';
import { showMenu } from './core/menu.js';
import { fmtBytes, fmtDate, joinPath, parentPath, baseName, shellQuote } from './core/format.js';
import { icon, fileIcon } from './core/icons.js';
import { state, bus, activeTab } from './state.js';
import { openEditor } from './editor.js';
import { uploadItems, collectEntries } from './transfers.js';

const isDirEntry = (e) => e.type === 'd' || e.target === 'd';
const call = (tab, op, body = {}) => api('POST', `/api/sftp/${tab.connId}/${op}`, body);
const loads = new WeakMap();
const currentLoad = (tab, request) =>
  loads.get(tab) === request && tab.sftp === request.sftp && tab.connId === request.connId && tab.status === 'connected' && !tab.disposed;

export function sftpTab() {
  const t = activeTab();
  return t && t.status === 'connected' && t.connId && t.target.kind === 'ssh' ? t : null;
}

export function sftpLoad(tab, path, options = {}) {
  return loadSftp(tab, path, options);
}

async function loadSftp(tab, path, { keepSelection = false, home = false } = {}) {
  if (!tab.connId || tab.status !== 'connected' || tab.disposed) return;
  // Giữ cả kết nối và đối tượng SFTP: reconnect thay đối tượng này trong lúc HTTP cũ vẫn có thể trả về.
  const request = { sftp: tab.sftp, connId: tab.connId, path };
  const sftp = request.sftp;
  loads.set(tab, request);
  sftp.loading = true;
  if (activeTab() === tab) renderSftp();
  try {
    if (home) {
      const r = await api('POST', `/api/sftp/${request.connId}/home`, {});
      if (!currentLoad(tab, request)) return;
      request.path = r.path;
    }
    let r;
    for (;;) {
      try {
        r = await api('POST', `/api/sftp/${request.connId}/list`, { path: request.path });
        break;
      } catch (e) {
        if (!currentLoad(tab, request)) return;
        if (sftp.cwd || request.path === '.') throw e;
        // Fallback thuộc cùng yêu cầu; không được chen lên thao tác chuyển thư mục mới hơn.
        request.path = '.';
      }
    }
    if (!currentLoad(tab, request)) return;
    const changedDir = r.path !== sftp.cwd;
    sftp.cwd = r.path;
    sftp.entries = r.entries;
    sftp.error = null;
    if (changedDir || !keepSelection) {
      sftp.selected = new Set();
      sftp.anchor = null;
    } else {
      const names = new Set(r.entries.map((e) => e.name));
      sftp.selected = new Set([...sftp.selected].filter((n) => names.has(n)));
      if (!names.has(sftp.anchor)) sftp.anchor = null;
    }
  } catch (e) {
    if (!currentLoad(tab, request)) return;
    if (!sftp.cwd) sftp.error = e.message;
    else toast(e.message, 'error');
  } finally {
    if (currentLoad(tab, request)) {
      sftp.loading = false;
      loads.delete(tab);
      if (activeTab() === tab) renderSftp();
    }
  }
}

const pressed = (sel) => $(sel).getAttribute('aria-pressed') === 'true';

function visibleEntries(tab) {
  const showHidden = pressed('#sftp-hidden');
  return tab.sftp.entries.filter((e) => showHidden || !e.name.startsWith('.'));
}

const selectedEntries = (tab) => tab.sftp.entries.filter((e) => tab.sftp.selected.has(e.name));

// Thanh đường dẫn dạng breadcrumb: bấm từng phần để nhảy tới, bấm vào khoảng trống để gõ đường dẫn.
function renderCrumbs(tab) {
  const box = $('#sftp-crumbs');
  if (!tab || !tab.sftp.cwd) {
    box.replaceChildren(el('span', { class: 'placeholder', text: tab ? 'Đang tải…' : 'Chưa kết nối' }));
    return;
  }
  const parts = tab.sftp.cwd.split('/').filter(Boolean);
  const go = (p) => (e) => {
    e.stopPropagation();
    sftpLoad(tab, p);
  };
  const nodes = [el('button', { type: 'button', class: 'crumb', text: '/', title: '/', onclick: go('/') })];
  parts.forEach((part, i) => {
    const full = '/' + parts.slice(0, i + 1).join('/');
    if (i > 0) nodes.push(icon('chevron-right', 'crumb-sep'));
    nodes.push(el('button', { type: 'button', class: 'crumb', text: part, title: full, onclick: go(full) }));
  });
  box.replaceChildren(...nodes);
  box.scrollLeft = box.scrollWidth;
}

function emptyState(iconName, text, ...extra) {
  return el('div', { class: 'empty' }, icon(iconName, 'empty-icon'), text, ...extra);
}

export function renderSftp() {
  const list = $('#sftp-list');
  const t = activeTab();
  const tab = sftpTab();
  renderCrumbs(tab);
  if (!tab) {
    const msg = !t ? 'Mở một tab SSH để duyệt file của server.' : t.target.kind === 'local' ? 'Panel SFTP không áp dụng cho terminal local.' : 'Tab này chưa kết nối.';
    list.replaceChildren(emptyState('folder', msg));
    $('#sftp-selection').textContent = '';
    bus.emit('sftp-rendered', null);
    return;
  }
  if (!tab.sftp.cwd && tab.sftp.error) {
    list.replaceChildren(
      emptyState(
        'alert',
        `Không mở được SFTP: ${tab.sftp.error}`,
        el('br'),
        el(
          'button',
          {
            class: 'btn',
            onclick: () => {
              tab.sftp.error = null;
              renderSftp();
            },
          },
          icon('refresh'),
          'Thử lại'
        )
      )
    );
    return;
  }
  if (!tab.sftp.cwd) {
    list.replaceChildren(el('div', { class: 'empty', text: 'Đang tải…' }));
    if (!tab.sftp.loading) sftpLoad(tab, tab.target.startDir || '.');
    return;
  }
  const rows = [];
  if (tab.sftp.cwd !== '/') {
    rows.push(
      el(
        'div',
        { class: 'sftp-row dir', title: 'Lên thư mục cha', ondblclick: () => sftpLoad(tab, parentPath(tab.sftp.cwd)) },
        icon('corner-up', 'fic k-up'),
        el('span', { class: 'fname', text: '..' }),
        el('span')
      )
    );
  }
  const entries = visibleEntries(tab);
  for (const e of entries) rows.push(row(tab, e));
  if (!entries.length) rows.push(emptyState('upload', 'Thư mục trống. Kéo thả file hoặc thư mục vào đây để upload.'));
  list.replaceChildren(...rows);
  updateSelectionInfo(tab);
  bus.emit('sftp-rendered', tab);
}

function updateSelectionInfo(tab) {
  const n = tab.sftp.selected.size;
  const info = $('#sftp-selection');
  if (!n) {
    info.textContent = `${visibleEntries(tab).length} mục`;
    return;
  }
  const size = selectedEntries(tab).reduce((a, e) => a + (isDirEntry(e) ? 0 : e.size), 0);
  info.textContent = `Đã chọn ${n} mục · ${fmtBytes(size)}`;
}

function markSelection(tab) {
  $$('#sftp-list .sftp-row[data-name]').forEach((n) => n.classList.toggle('selected', tab.sftp.selected.has(n.dataset.name)));
  updateSelectionInfo(tab);
}

// Click thường: chọn một; Ctrl: thêm/bớt; Shift: chọn cả đoạn từ mục đã chọn trước.
function selectEntry(tab, name, ev) {
  const names = visibleEntries(tab).map((e) => e.name);
  const sel = tab.sftp.selected;
  if (ev.shiftKey && tab.sftp.anchor && names.includes(tab.sftp.anchor)) {
    const [a, b] = [names.indexOf(tab.sftp.anchor), names.indexOf(name)].sort((x, y) => x - y);
    if (!ev.ctrlKey) sel.clear();
    names.slice(a, b + 1).forEach((n) => sel.add(n));
  } else if (ev.ctrlKey || ev.metaKey) {
    sel.has(name) ? sel.delete(name) : sel.add(name);
    tab.sftp.anchor = name;
  } else {
    sel.clear();
    sel.add(name);
    tab.sftp.anchor = name;
  }
  markSelection(tab);
}

function row(tab, e) {
  const dir = isDirEntry(e);
  const fi = fileIcon(e);
  return el(
    'div',
    {
      class: `sftp-row${dir ? ' dir' : ''}${e.type === 'l' ? ' link' : ''}${tab.sftp.selected.has(e.name) ? ' selected' : ''}`,
      dataset: { name: e.name },
      title: `${e.name}\n${e.perms}  ${dir ? '' : fmtBytes(e.size)}\n${fmtDate(e.mtime)}`,
      onclick: (ev) => selectEntry(tab, e.name, ev),
      ondblclick: () => openEntry(tab, e),
      oncontextmenu: (ev) => {
        if (!tab.sftp.selected.has(e.name)) selectEntry(tab, e.name, {});
        entryMenu(ev, tab);
      },
    },
    icon(fi.name, `fic k-${fi.kind}`),
    el('span', { class: 'fname', text: e.type === 'l' ? `${e.name}${e.target === 'broken' ? ' (hỏng)' : ''}` : e.name }),
    el('span', { class: 'fsize', text: dir ? '' : fmtBytes(e.size) })
  );
}

function openEntry(tab, e) {
  const full = joinPath(tab.sftp.cwd, e.name);
  if (isDirEntry(e)) return sftpLoad(tab, full);
  openEditor(tab, full, (p) => downloadFile(tab, p));
}

function entryMenu(ev, tab) {
  const sel = selectedEntries(tab);
  if (!sel.length) return;
  const one = sel.length === 1 ? sel[0] : null;
  const full = one && joinPath(tab.sftp.cwd, one.name);
  const items = one
    ? [
        isDirEntry(one)
          ? { icon: 'folder', label: 'Mở', action: () => sftpLoad(tab, full) }
          : { icon: 'file-text', label: 'Sửa file', action: () => openEditor(tab, full, (p) => downloadFile(tab, p)) },
        ...bus.collect('sftp-menu-extra', { tab, entry: one, path: full }),
        isDirEntry(one) && { icon: 'terminal', label: 'cd terminal tới đây', action: () => cdTerminal(tab, full) },
        { icon: 'download', label: isDirEntry(one) ? 'Tải thư mục (.zip)' : 'Tải về máy', action: () => download(tab, sel) },
        { icon: 'edit', label: 'Đổi tên / di chuyển', action: () => renameEntry(tab, one) },
        { icon: 'shield', label: 'Phân quyền (chmod)', action: () => chmodEntries(tab, sel) },
        { icon: 'copy', label: 'Copy đường dẫn', action: () => copyText(full) },
        '-',
        { icon: 'trash', label: 'Xoá', danger: true, action: () => deleteEntries(tab, sel) },
      ]
    : [
        { icon: 'download', label: `Tải ${sel.length} mục (.zip)`, action: () => download(tab, sel) },
        { icon: 'shield', label: `Phân quyền ${sel.length} mục`, action: () => chmodEntries(tab, sel) },
        { icon: 'copy', label: 'Copy các đường dẫn', action: () => copyText(sel.map((e) => joinPath(tab.sftp.cwd, e.name)).join('\n')) },
        '-',
        { icon: 'trash', label: `Xoá ${sel.length} mục`, danger: true, action: () => deleteEntries(tab, sel) },
      ];
  showMenu(ev, items);
}

export function cdTerminal(tab, path) {
  tab.sendText(`cd ${shellQuote(path)}\r`);
  tab.term.focus();
}

export function downloadFile(tab, path) {
  const a = el('a', { href: `/api/sftp/${tab.connId}/download?path=${encodeURIComponent(path)}`, download: baseName(path) });
  document.body.append(a);
  a.click();
  a.remove();
}

// Một file: tải thẳng. Thư mục hoặc nhiều mục: server gói zip theo dạng stream.
async function download(tab, entries) {
  if (entries.length === 1 && !isDirEntry(entries[0])) return downloadFile(tab, joinPath(tab.sftp.cwd, entries[0].name));
  try {
    const { ticket } = await call(tab, 'zip', { paths: entries.map((e) => joinPath(tab.sftp.cwd, e.name)) });
    const a = el('a', { href: `/api/sftp/${tab.connId}/download-zip?ticket=${encodeURIComponent(ticket)}` });
    document.body.append(a);
    a.click();
    a.remove();
    toast('Đang nén và tải về…', 'info', 2500);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function renameEntry(tab, e) {
  const r = await promptDialog({
    title: 'Đổi tên / di chuyển',
    message: 'Nhập tên mới, hoặc đường dẫn tuyệt đối (bắt đầu bằng /) để di chuyển.',
    fields: [{ name: 'to', label: 'Tên mới', value: e.name }],
    okText: 'Đổi',
  });
  if (!r || !r.to.trim() || r.to.trim() === e.name) return;
  try {
    await call(tab, 'rename', { from: joinPath(tab.sftp.cwd, e.name), to: joinPath(tab.sftp.cwd, r.to.trim()) });
    sftpLoad(tab, tab.sftp.cwd);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function chmodEntries(tab, entries) {
  const first = entries[0];
  const cur = first.mode.toString(8).padStart(3, '0');
  const r = await promptDialog({
    title: entries.length === 1 ? `Phân quyền: ${first.name}` : `Phân quyền ${entries.length} mục`,
    message: `${entries.length === 1 ? `Hiện tại: ${first.perms} (${cur}). ` : ''}Ví dụ: 644 cho file, 755 cho thư mục/script.`,
    fields: [{ name: 'mode', label: 'Mã quyền (octal)', value: cur }],
    okText: 'Áp dụng',
  });
  if (!r) return;
  let failed = 0;
  for (const e of entries) {
    try {
      await call(tab, 'chmod', { path: joinPath(tab.sftp.cwd, e.name), mode: r.mode.trim() });
    } catch (err) {
      failed++;
      if (failed === 1) toast(err.message, 'error');
    }
  }
  sftpLoad(tab, tab.sftp.cwd, { keepSelection: true });
}

async function deleteEntries(tab, entries) {
  const dirs = entries.filter((e) => e.type === 'd').length;
  const names = entries.slice(0, 6).map((e) => e.name).join(', ') + (entries.length > 6 ? `… (+${entries.length - 6})` : '');
  const msg = `${entries.length === 1 ? joinPath(tab.sftp.cwd, entries[0].name) : `${entries.length} mục: ${names}`}${dirs ? '\nThư mục sẽ bị xoá cùng toàn bộ nội dung bên trong.' : ''}\nKhông thể hoàn tác.`;
  if (!(await confirmDialog('Xoá vĩnh viễn?', msg, 'Xoá', true))) return;
  let ok = 0;
  for (const e of entries) {
    try {
      await call(tab, 'delete', { path: joinPath(tab.sftp.cwd, e.name) });
      ok++;
    } catch (err) {
      toast(`${e.name}: ${err.message}`, 'error');
    }
  }
  if (ok) toast(`Đã xoá ${ok} mục`, 'ok');
  sftpLoad(tab, tab.sftp.cwd);
}

async function createEntry(tab, kind) {
  const r = await promptDialog({
    title: kind === 'mkdir' ? 'Tạo thư mục' : 'Tạo file mới',
    fields: [{ name: 'name', label: 'Tên', placeholder: kind === 'mkdir' ? 'thu-muc-moi' : 'file.txt' }],
    okText: 'Tạo',
  });
  if (!r || !r.name.trim()) return;
  const full = joinPath(tab.sftp.cwd, r.name.trim());
  try {
    if (kind === 'touch' && (await call(tab, 'exists', { path: full })).exists) return toast('File đã tồn tại', 'error');
    await call(tab, kind, { path: full });
    await sftpLoad(tab, tab.sftp.cwd);
    if (kind === 'touch') openEditor(tab, full, (p) => downloadFile(tab, p));
  } catch (err) {
    toast(err.message, 'error');
  }
}

function uploadFileList(tab, files) {
  const items = [...files].map((file) => ({ file, relPath: file.webkitRelativePath || file.name }));
  uploadItems(tab, items, tab.sftp.cwd, tab.sftp.entries.map((e) => e.name));
}

export function initSftp() {
  $('#side-sftp .sftp-toolbar').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-sftp]');
    const tab = sftpTab();
    if (!btn || !tab || !tab.sftp.cwd) return;
    switch (btn.dataset.sftp) {
      case 'up':
        return sftpLoad(tab, parentPath(tab.sftp.cwd));
      case 'home':
        return loadSftp(tab, '.', { home: true });
      case 'refresh':
        return sftpLoad(tab, tab.sftp.cwd, { keepSelection: true });
      case 'upload':
        return $('#sftp-file-input').click();
      case 'upload-dir':
        return $('#sftp-dir-input').click();
      case 'mkdir':
      case 'touch':
        return createEntry(tab, btn.dataset.sftp);
      case 'cd':
        return cdTerminal(tab, tab.sftp.cwd);
    }
  });
  for (const id of ['#sftp-file-input', '#sftp-dir-input']) {
    $(id).addEventListener('change', (e) => {
      const tab = sftpTab();
      const files = [...e.target.files];
      e.target.value = '';
      if (tab && files.length) uploadFileList(tab, files);
    });
  }
  $('#sftp-hidden').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    btn.replaceChildren(icon(on ? 'eye-off' : 'eye'));
    btn.title = on ? 'Ẩn file ẩn' : 'Hiện file ẩn';
    renderSftp();
  });

  // Đường dẫn: mặc định là breadcrumb; bấm vào khoảng trống để gõ đường dẫn.
  const pathInput = $('#sftp-path');
  const crumbs = $('#sftp-crumbs');
  const endPathEdit = () => {
    pathInput.hidden = true;
    crumbs.hidden = false;
  };
  crumbs.addEventListener('click', () => {
    const tab = sftpTab();
    if (!tab || !tab.sftp.cwd) return;
    pathInput.value = tab.sftp.cwd;
    crumbs.hidden = true;
    pathInput.hidden = false;
    pathInput.focus();
    pathInput.select();
  });
  pathInput.addEventListener('blur', endPathEdit);
  pathInput.addEventListener('keydown', (e) => e.key === 'Escape' && (e.preventDefault(), endPathEdit()));
  $('#sftp-path-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const tab = sftpTab();
    const p = pathInput.value.trim();
    endPathEdit();
    if (tab && p) sftpLoad(tab, p);
    $('#sftp-list').focus();
  });

  const list = $('#sftp-list');
  list.addEventListener('contextmenu', (e) => {
    const tab = sftpTab();
    if (!tab || e.target.closest('.sftp-row')) return;
    showMenu(e, [
      { icon: 'refresh', label: 'Làm mới', action: () => sftpLoad(tab, tab.sftp.cwd, { keepSelection: true }) },
      { icon: 'upload', label: 'Upload file…', action: () => $('#sftp-file-input').click() },
      { icon: 'folder-up', label: 'Upload thư mục…', action: () => $('#sftp-dir-input').click() },
      '-',
      { icon: 'folder-plus', label: 'Tạo thư mục', action: () => createEntry(tab, 'mkdir') },
      { icon: 'file-plus', label: 'Tạo file', action: () => createEntry(tab, 'touch') },
      { icon: 'terminal', label: 'cd terminal tới đây', action: () => cdTerminal(tab, tab.sftp.cwd) },
    ]);
  });
  list.addEventListener('keydown', (e) => {
    const tab = sftpTab();
    if (!tab || !tab.sftp.cwd) return;
    const sel = selectedEntries(tab);
    if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      tab.sftp.selected = new Set(visibleEntries(tab).map((x) => x.name));
      markSelection(tab);
    } else if (e.key === 'Delete' && sel.length) deleteEntries(tab, sel);
    else if (e.key === 'F2' && sel.length === 1) renameEntry(tab, sel[0]);
    else if (e.key === 'Enter' && sel.length === 1) openEntry(tab, sel[0]);
    else if (e.key === 'Backspace') {
      e.preventDefault();
      sftpLoad(tab, parentPath(tab.sftp.cwd));
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const names = visibleEntries(tab).map((x) => x.name);
      if (!names.length) return;
      const cur = names.indexOf(tab.sftp.anchor);
      const next = names[Math.max(0, Math.min(names.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))];
      selectEntry(tab, next, { shiftKey: e.shiftKey });
      const node = list.querySelector(`.sftp-row[data-name="${CSS.escape(next)}"]`);
      if (node) node.scrollIntoView({ block: 'nearest' });
    }
  });
  list.addEventListener('dragover', (e) => {
    if (!sftpTab() || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    list.classList.add('drop');
  });
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) list.classList.remove('drop');
  });
  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    list.classList.remove('drop');
    const tab = sftpTab();
    if (!tab) return;
    // Phải lấy entry ngay trong sự kiện drop; sau khi handler trả về, dữ liệu kéo thả không còn.
    const entries = [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    const destDir = tab.sftp.cwd;
    const existing = tab.sftp.entries.map((x) => x.name);
    try {
      const { items, dirs } = await collectEntries(entries);
      uploadItems(tab, items, destDir, existing, dirs);
    } catch (err) {
      toast(`Không đọc được file kéo thả: ${err.message}`, 'error');
    }
  });

  bus.on('active-changed', renderSftp);
  bus.on('tab-status', (tab) => state.activeKey === tab.key && renderSftp());
  bus.on('sftp-refresh', (tab) => tab.sftp.cwd && tab.status === 'connected' && sftpLoad(tab, tab.sftp.cwd, { keepSelection: true }));
  initFollow();
  initExternalEdit();
}

// ---------- SFTP theo thư mục của terminal ----------
// Chỉ dò khi bật nút ghim, tab đang chọn và panel SFTP đang mở (để không tốn tài nguyên server).
let sideVisible = false;

function syncFollow() {
  const active = sftpTab();
  for (const t of tabsWithSftp()) {
    const want = t === active && t.sftp.follow && sideVisible;
    if (want !== Boolean(t.followSent)) {
      t.followSent = want;
      t.control({ type: 'follow', enabled: want });
    }
  }
  const btn = $('#sftp-follow');
  btn.setAttribute('aria-pressed', String(Boolean(active && active.sftp.follow)));
  btn.disabled = !active;
}

function tabsWithSftp() {
  return [...(bus.collect('all-tabs') || [])];
}

function followTo(tab, path) {
  if (!tab.sftp.follow || !path) return;
  const request = loads.get(tab);
  if (request && currentLoad(tab, request)) {
    if (request.path === path) return;
  } else if (path === tab.sftp.cwd) return;
  sftpLoad(tab, path);
}

function initFollow() {
  $('#sftp-follow').addEventListener('click', () => {
    const tab = sftpTab();
    if (!tab) return;
    tab.sftp.follow = !tab.sftp.follow;
    syncFollow();
    if (tab.sftp.follow) toast('Panel SFTP sẽ đi theo thư mục hiện tại của terminal', 'info', 2500);
  });
  bus.on('side-changed', (name) => {
    sideVisible = name === 'sftp';
    syncFollow();
  });
  bus.on('active-changed', syncFollow);
  bus.on('tab-status', (tab) => {
    if (tab.status !== 'connected') tab.followSent = false;
    syncFollow();
  });
  bus.on('ws:cwd', ({ tab, msg }) => {
    if (msg.unsupported) {
      if (tab.sftp.follow) toast('Server này không hỗ trợ "SFTP theo terminal" (cần Linux + OpenSSH)', 'info', 5000);
      tab.sftp.follow = false;
      syncFollow();
      return;
    }
    followTo(tab, msg.path);
  });
  // Shell tự báo thư mục (OSC 7 / 633 / 1337) thì dùng luôn, không cần chờ server dò.
  bus.on('osc-cwd', ({ tab, path }) => followTo(tab, path));
}

// ---------- Sửa bằng app ngoài ----------

async function editExternal(tab, path) {
  try {
    const r = await call(tab, 'edit-external', { path });
    toast(`Đang mở ${baseName(path)} bằng ${r.editor}. Mỗi lần bạn lưu trong editor, file sẽ tự upload lên server.`, 'info', 6000);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function initExternalEdit() {
  bus.provide('sftp-menu-extra', ({ tab, entry, path }) =>
    state.capabilities.localFeatures && !isDirEntry(entry) ? [{ icon: 'external', label: 'Sửa bằng app ngoài', action: () => editExternal(tab, path) }] : []
  );
  bus.on('ws:edit-sync', async ({ tab, msg }) => {
    if (msg.status === 'uploaded') {
      toast(`✓ Đã upload ${baseName(msg.path)} lên server`, 'ok', 2500);
      if (tab.sftp.cwd && msg.path.startsWith(tab.sftp.cwd)) sftpLoad(tab, tab.sftp.cwd, { keepSelection: true });
    } else if (msg.status === 'conflict') {
      const ok = await confirmDialog(
        'File trên server đã thay đổi',
        `${msg.path} vừa bị sửa trên server sau khi bạn mở. Ghi đè bằng bản bạn đang sửa?`,
        'Ghi đè lên server',
        true
      );
      if (ok) {
        try {
          await api('POST', `/api/sftp/${tab.connId}/edit-external/${msg.editId}/upload`);
        } catch (e) {
          toast(e.message, 'error');
        }
      }
    } else if (msg.status === 'error') toast(`Lỗi khi upload ${baseName(msg.path)}: ${msg.message}`, 'error', 6000);
  });
}
