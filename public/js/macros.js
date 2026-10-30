// Tab Macros ở thanh bên: lưu lệnh hay dùng, ghi lại phím gõ, chạy trên tab hiện tại hoặc mọi tab MultiExec.
import { $, $$, el, toast } from './core/dom.js';
import { api } from './core/api.js';
import { openModal, confirmDialog } from './core/dialogs.js';
import { showMenu } from './core/menu.js';
import { storage } from './core/storage.js';
import { icon } from './core/icons.js';
import { state, tabs, bus, activeTab } from './state.js';

import { escapeKeys, unescapeKeys } from './keys.js';

let list = [];
let editing = null;
let recording = null; // { key, data }

export async function loadMacros() {
  try {
    list = await api('GET', '/api/macros');
  } catch {
    list = [];
  }
  render();
}

function targets() {
  if (state.multiExec) return [...tabs.values()].filter((t) => t.multi && t.status === 'connected');
  const t = activeTab();
  return t && t.status === 'connected' ? [t] : [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runMacro(m) {
  const ts = targets();
  if (!ts.length) return toast('Hãy chọn một tab terminal đang kết nối để chạy macro', 'error');
  // Gửi thẳng tới từng tab (không qua input() để MultiExec không phát lặp).
  if (m.kind === 'keys') {
    const data = unescapeKeys(m.keys);
    ts.forEach((t) => t.sendText(data));
  } else {
    const lines = m.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i] && i === lines.length - 1) break;
      ts.forEach((t) => t.sendText(lines[i] + (m.enter ? '\r' : '')));
      if (m.delay && i < lines.length - 1) await sleep(m.delay);
    }
  }
  ts[0].term.focus();
  if (ts.length > 1) toast(`Đã chạy "${m.name}" trên ${ts.length} tab`, 'ok', 1800);
}

function preview(m) {
  if (m.kind === 'keys') return `⌨ ${unescapeKeys(m.keys).length} phím đã ghi`;
  const lines = m.text.split('\n').filter(Boolean);
  return lines[0] + (lines.length > 1 ? `  (+${lines.length - 1} dòng)` : '');
}

function item(m) {
  return el(
    'div',
    {
      class: 'session-item macro-item',
      tabindex: 0,
      title: `${m.name}\n\n${m.kind === 'keys' ? escapeKeys(unescapeKeys(m.keys)) : m.text}`,
      ondblclick: () => runMacro(m),
      onkeydown: (e) => e.key === 'Enter' && runMacro(m),
      oncontextmenu: (e) =>
        showMenu(e, [
          { icon: 'play', label: state.multiExec ? 'Chạy trên mọi tab MultiExec' : 'Chạy trên tab hiện tại', action: () => runMacro(m) },
          { icon: 'edit', label: 'Sửa', action: () => editMacro(m) },
          { icon: 'duplicate', label: 'Nhân bản', action: () => editMacro(null, { ...m, name: `${m.name} (bản sao)` }) },
          '-',
          { icon: 'trash', label: 'Xoá', danger: true, action: () => deleteMacro(m) },
        ]),
    },
    el('span', { class: 'avatar' }, icon(m.kind === 'keys' ? 'keyboard' : 'zap')),
    el('div', { class: 'meta' }, el('div', { class: 'name' }, el('span', { class: 'nm', text: m.name })), el('div', { class: 'sub', text: preview(m) })),
    el(
      'div',
      { class: 'row-actions' },
      el(
        'button',
        {
          class: 'icon-btn go',
          title: 'Chạy',
          'aria-label': 'Chạy',
          onclick: (e) => {
            e.stopPropagation();
            runMacro(m);
          },
        },
        icon('play')
      ),
      el(
        'button',
        {
          class: 'icon-btn',
          title: 'Sửa',
          'aria-label': 'Sửa',
          onclick: (e) => {
            e.stopPropagation();
            editMacro(m);
          },
        },
        icon('edit')
      )
    )
  );
}

function render() {
  const box = $('#macro-list');
  const q = $('#macro-search').value.trim().toLowerCase();
  const items = list.filter((m) => !q || [m.name, m.folder, m.text, m.keys].some((v) => (v || '').toLowerCase().includes(q)));
  $('#macro-folder-list').replaceChildren(...[...new Set(list.map((m) => m.folder).filter(Boolean))].map((f) => el('option', { value: f })));
  if (!list.length) {
    box.replaceChildren(
      el(
        'div',
        { class: 'empty' },
        icon('zap', 'empty-icon'),
        'Chưa có macro. Lưu các lệnh hay dùng để chạy bằng một cú click, hoặc ghi lại thao tác gõ phím.',
        el('br'),
        el('button', { class: 'btn primary', onclick: () => editMacro() }, icon('plus'), 'Macro mới')
      )
    );
    return;
  }
  const groups = new Map();
  for (const m of items.sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }))) {
    const g = m.folder || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }
  const closed = new Set(storage.get('wt.closedMacroFolders', []));
  const nodes = [];
  for (const [g, ms] of [...groups.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'vi')))) {
    if (!g) {
      nodes.push(...ms.map(item));
      continue;
    }
    const det = el(
      'details',
      { open: !closed.has(g) },
      el('summary', {}, icon('chevron-right', 'chev'), icon('folder', 'fold'), el('span', { class: 'folder-name', text: g }), el('span', { class: 'count', text: String(ms.length) })),
      el('div', { class: 'folder-body' }, ...ms.map(item))
    );
    det.addEventListener('toggle', () => {
      const set = new Set(storage.get('wt.closedMacroFolders', []));
      det.open ? set.delete(g) : set.add(g);
      storage.set('wt.closedMacroFolders', [...set]);
    });
    nodes.push(det);
  }
  box.replaceChildren(...(nodes.length ? nodes : [el('div', { class: 'empty', text: 'Không tìm thấy.' })]));
}

function toggleKind() {
  const kind = $('#macro-form').elements.kind.value;
  $$('#macro-form .k-text').forEach((n) => n.classList.toggle('hidden', kind !== 'text'));
  $$('#macro-form .k-keys').forEach((n) => n.classList.toggle('hidden', kind !== 'keys'));
}

export function editMacro(m = null, preset = {}) {
  const f = $('#macro-form');
  f.reset();
  editing = m;
  const v = m || { kind: 'text', enter: true, delay: 150, ...preset };
  $('#macro-form-title').textContent = m ? `Sửa macro: ${m.name}` : 'Macro mới';
  f.elements.name.value = v.name || '';
  f.elements.folder.value = v.folder || '';
  f.elements.kind.value = v.kind || 'text';
  f.elements.text.value = v.text || '';
  f.elements.enter.checked = v.enter !== false;
  f.elements.delay.value = v.delay ?? 150;
  f.elements.keys.value = v.keys ? escapeKeys(unescapeKeys(v.keys)) : '';
  toggleKind();
  openModal($('#dlg-macro'));
  f.elements.name.focus();
}

async function deleteMacro(m) {
  if (!(await confirmDialog('Xoá macro?', `Xoá "${m.name}"?`, 'Xoá', true))) return;
  try {
    await api('DELETE', `/api/macros/${m.id}`);
    loadMacros();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function setRecording(on) {
  const btn = $('#macro-record');
  if (on) {
    const t = activeTab();
    if (!t || t.status !== 'connected') return toast('Hãy chọn một tab terminal đang kết nối rồi bấm Ghi', 'error');
    recording = { key: t.key, data: '' };
    btn.classList.add('recording');
    btn.replaceChildren(icon('stop'));
    btn.title = 'Dừng ghi và lưu macro';
    toast('Đang ghi phím trong tab hiện tại. Lưu ý: mật khẩu gõ trong lúc ghi (vd. sudo) cũng bị lưu vào macro.', 'info', 6000);
    t.term.focus();
  } else {
    const rec = recording;
    recording = null;
    btn.classList.remove('recording');
    btn.replaceChildren(icon('record'));
    btn.title = 'Ghi lại các phím gõ trong tab đang chọn';
    if (!rec || !rec.data) return toast('Chưa ghi được phím nào', 'info');
    // Ghi lại toàn dòng lệnh: lưu dạng phím để giữ đúng cả phím mũi tên, Tab, Ctrl+C...
    editMacro(null, { kind: 'keys', keys: rec.data, name: '' });
  }
}

export function initMacros() {
  $('#macro-new').addEventListener('click', () => editMacro());
  $('#macro-record').addEventListener('click', () => setRecording(!recording));
  $('#macro-search').addEventListener('input', render);
  $$('#macro-form input[name=kind]').forEach((r) => r.addEventListener('change', toggleKind));
  $('#macro-form').addEventListener('submit', async (e) => {
    const action = e.submitter ? e.submitter.value : 'save';
    if (action === 'cancel') return;
    e.preventDefault();
    const f = e.target.elements;
    const kind = f.kind.value;
    const payload = { name: f.name.value, folder: f.folder.value, kind };
    if (kind === 'text') Object.assign(payload, { text: f.text.value, enter: f.enter.checked, delay: Number(f.delay.value) || 0 });
    else payload.keys = unescapeKeys(f.keys.value);
    try {
      if (editing) await api('PUT', `/api/macros/${editing.id}`, payload);
      else await api('POST', '/api/macros', payload);
      $('#dlg-macro').close('saved');
      toast('Đã lưu macro', 'ok', 1500);
      loadMacros();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  bus.on('term-input', ({ tab, data }) => {
    if (recording && recording.key === tab.key) recording.data += data;
  });
  bus.on('tab-closed', (tab) => recording && recording.key === tab.key && setRecording(false));
  bus.on('macros-reload', loadMacros);
}
