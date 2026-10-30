// Ctrl+K: tìm session, chuyển tab và mở công cụ bằng bàn phím.
import { $, el, toast } from './core/dom.js';
import { icon } from './core/icons.js';
import { hideMenu } from './core/menu.js';
import { storage } from './core/storage.js';
import { searchCommands } from './core/command-search.js';
import { state, tabs, bus } from './state.js';
import { activate } from './term/tab.js';
import { editSession, openSession, sessionSub, TYPE_ICON } from './sessions.js';
import { openLocal } from './local.js';
import { openSettings, toggleUiTheme } from './settings.js';
import { openTunnels } from './tunnels.js';
import { openImport } from './import.js';
import { setLayout } from './layout.js';

const STATUS = { connected: 'Đã kết nối', connecting: 'Đang kết nối', closed: 'Đã đóng', error: 'Lỗi kết nối' };
let matches = [];
let selected = 0;
const dialog = () => $('#dlg-commands');
const input = () => $('#command-input');

function commands() {
  const list = [...tabs.values()].sort((a, b) => Number(b.key === state.activeKey) - Number(a.key === state.activeKey)).map((tab) => ({
    id: `tab-${tab.key}`, group: 'Tab đang mở', icon: tab.target.kind === 'local' ? 'terminal' : 'server',
    label: tab.nameEl.textContent, detail: `${STATUS[tab.status] || tab.status} · ${tab.label}`,
    keywords: 'tab terminal', action: () => activate(tab.key),
  }));
  const recent = storage.get('wt.recent', []);
  const rank = (session) => { const i = Array.isArray(recent) ? recent.indexOf(session.id) : -1; return i < 0 ? Infinity : i; };
  const sessions = state.sessions.filter((s) => state.capabilities.localFeatures || !['local', 'rdp'].includes(s.type));
  sessions.sort((a, b) => (rank(a) - rank(b)) || a.name.localeCompare(b.name, 'vi', { numeric: true }));
  list.push(...sessions.map((session) => ({
    id: `session-${session.id}`, group: 'Sessions', icon: TYPE_ICON[session.type || 'ssh'],
    label: session.name, detail: [session.folder, sessionSub(session)].filter(Boolean).join(' · '),
    keywords: `${session.notes || ''} ${session.type || 'ssh'}`, action: () => openSession(session),
  })));
  list.push(...bus.collect('closed-tabs').map((item) => ({ ...item, group: 'Tab vừa đóng', keywords: 'reopen khoi phuc mo lai' })));
  const action = (id, label, iconName, fn, detail = '', keywords = '') => ({ id, group: 'Thao tác', label, icon: iconName, action: fn, detail, keywords });
  list.push(
    action('session-new', 'Tạo session mới', 'server-plus', () => editSession(), 'SSH, RDP hoặc terminal local', 'new connect ket noi'),
    ...(state.capabilities.localFeatures ? (state.shells || []).map((shell) => action(`local-${shell.id}`, `Mở ${shell.name}`, 'terminal', () => openLocal(shell), 'Terminal trên máy này', 'local shell')) : []),
    action('quick-connect', 'Kết nối nhanh', 'zap', () => $('#quick-input').focus(), 'user@host:port', 'ssh quick connect'),
    action('home', 'Về trang chủ', 'home', () => activate('home')),
    action('settings', 'Mở cài đặt', 'settings', () => openSettings(), 'Giao diện, terminal và bảo mật', 'settings font theme'),
    action('theme', 'Đổi giao diện sáng / tối', 'moon', toggleUiTheme, '', 'theme light dark'),
    action('tunnels', 'Quản lý SSH tunnel', 'tunnel', openTunnels),
    action('import', 'Import session từ MobaXterm', 'import', openImport),
    action('layout-1', 'Một màn hình', 'square', () => setLayout('1'), '', 'split chia'),
    action('layout-2v', 'Chia 2 cột', 'split', () => setLayout('2v'), '', 'split layout'),
    action('layout-2h', 'Chia 2 hàng', 'rows', () => setLayout('2h'), '', 'split layout'),
    action('layout-4', 'Chia 4 ô', 'grid', () => setLayout('4'), '', 'split layout'),
    ...bus.collect('tools-menu').filter((item) => item && typeof item.action === 'function' && !item.disabled).map((item, i) => action(`tool-${i}`, item.label, item.icon || 'tools', item.action))
  );
  return list;
}

function select(index) {
  selected = Math.max(0, Math.min(index, matches.length - 1));
  const list = $('#command-results');
  list.querySelectorAll('[role=option]').forEach((row, i) => {
    row.classList.toggle('selected', i === selected);
    row.setAttribute('aria-selected', String(i === selected));
  });
  const row = list.querySelector('.selected');
  if (row) {
    input().setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView({ block: 'nearest' });
  } else input().removeAttribute('aria-activedescendant');
}

function render(reset = true) {
  const selectedId = reset ? null : matches[selected]?.id;
  const all = searchCommands(commands(), input().value);
  matches = all.slice(0, 80);
  const nodes = [];
  let previousGroup = '';
  for (const [i, item] of matches.entries()) {
    if (previousGroup !== item.group) nodes.push(el('div', { class: 'command-group', role: 'presentation', text: item.group }));
    previousGroup = item.group;
    nodes.push(el('div', {
      id: `command-option-${i}`, class: 'command-item', role: 'option', 'aria-selected': 'false',
      onclick: () => run(i),
    }, icon(item.icon), el('div', { class: 'command-meta' }, el('div', { class: 'command-name', text: item.label }), item.detail && el('div', { class: 'command-detail', text: item.detail })), icon('arrow-right', 'command-go')));
  }
  if (!nodes.length) nodes.push(el('div', { class: 'empty', text: 'Không tìm thấy. Thử tên session, host hoặc tên công cụ.' }));
  $('#command-results').replaceChildren(...nodes);
  $('#command-count').textContent = all.length > matches.length ? `${matches.length} / ${all.length} kết quả · Nhập thêm để lọc` : `${all.length} kết quả`;
  const previousIndex = matches.findIndex((item) => item.id === selectedId);
  select(previousIndex < 0 ? 0 : previousIndex);
}

async function run(index) {
  const command = matches[index];
  if (!command) return;
  dialog().close();
  try {
    await command.action();
  } catch (e) {
    toast(e.message || 'Không thực hiện được thao tác', 'error');
  }
}

export function openCommands() {
  if (dialog().open) { input().focus(); input().select(); return; }
  if (document.querySelector('dialog[open]')) return;
  hideMenu();
  input().value = '';
  render();
  dialog().showModal();
  input().focus();
}

export function initCommands() {
  $('#btn-commands').addEventListener('click', openCommands);
  input().addEventListener('input', () => render());
  input().addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      select(matches.length ? (selected + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(selected);
    }
  });
  $('#command-close').addEventListener('click', () => dialog().close());
  dialog().addEventListener('click', (e) => {
    if (e.target !== dialog()) return;
    const bounds = dialog().getBoundingClientRect();
    if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) dialog().close();
  });
  // Capture để Ctrl+K không bị gửi thành lệnh xoá dòng vào shell khi mở bảng.
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k' || e.isComposing) return;
    if (document.querySelector('dialog[open]') && !dialog().open) return;
    e.preventDefault();
    e.stopPropagation();
    if (dialog().open) dialog().close();
    else openCommands();
  }, true);
  for (const event of ['sessions-changed', 'tabs-changed', 'tab-status', 'tab-history-changed']) bus.on(event, () => { if (dialog().open) render(false); });
}
