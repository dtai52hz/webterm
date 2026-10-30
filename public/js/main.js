// Điểm vào của giao diện: nối thanh công cụ, thanh bên và khởi động các module.
import { $, $$, el, toast } from './core/dom.js';
import { api } from './core/api.js';
import { showMenuAt } from './core/menu.js';
import { icon, hydrateIcons } from './core/icons.js';
import { state, tabs, bus } from './state.js';
import { TermTab, activate } from './term/tab.js';
import { setMultiExec } from './multiexec.js';
import { renderStatus } from './statusbar.js';
import { initSftp, renderSftp } from './sftp.js';
import { initEditor } from './editor.js';
import { initSessions, loadSessions, editSession } from './sessions.js';
import { initImport, openImport } from './import.js';
import { initSettings, loadSettings } from './settings.js';
import { initLayout } from './layout.js';
import { initMacros, loadMacros } from './macros.js';
import { connectServerEvents } from './server-events.js';
import { initTunnels, openTunnels } from './tunnels.js';
import { initLocal, loadShells, openLocal } from './local.js';
import { initKeygen } from './keygen.js';
import { initVault } from './vault.js';
import { initBackup } from './backup.js';
import { initPortable } from './portable.js';
import { initCommands } from './commands.js';
import { initTabHistory, reopenTab, closedTabItems } from './tab-history.js';
import { initTabNavigation } from './tab-navigation.js';
import './term/highlight.js';

const narrow = () => window.matchMedia('(max-width: 760px)').matches;
const sidebarShown = () => (narrow() ? document.body.classList.contains('sidebar-open') : !document.body.classList.contains('sidebar-collapsed'));

function setSidebar(show) {
  if (narrow()) document.body.classList.toggle('sidebar-open', show);
  else document.body.classList.toggle('sidebar-collapsed', !show);
  tabs.forEach((t) => t.scheduleFit());
}

function switchSide(name) {
  $$('.side-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.side === name));
  $$('.side-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `side-${name}`));
  if (name === 'sftp') renderSftp();
  bus.emit('side-changed', name);
}

function showLocked(message) {
  $('.home-dash').replaceChildren(
    el('div', { class: 'hero' }, el('div', { class: 'hero-logo' }, icon('logo')), el('div', {}, el('h1', { text: 'WebTerm' }), el('p', { text: 'Chưa đăng nhập' }))),
    el('div', { class: 'alert', text: message }),
    el('p', { class: 'muted', text: 'Link có dạng http://127.0.0.1:3366/?token=… và được in ra khi chạy "npm start".' })
  );
}

function parseQuick(value) {
  const m = value.trim().match(/^(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s@]+)(?::(\d+))?$/);
  if (!m) return null;
  return { username: m[1] || '', host: m[2].replace(/^\[|\]$/g, ''), port: Number(m[3]) || 22 };
}

function initToolbar() {
  $('#btn-sidebar').addEventListener('click', () => setSidebar(!sidebarShown()));
  $('#btn-new-session').addEventListener('click', () => editSession());
  $('#side-new-session').addEventListener('click', () => editSession());
  $('#side-import').addEventListener('click', openImport);
  $('#home-new').addEventListener('click', () => editSession());
  $('#home-import').addEventListener('click', openImport);
  $('#home-tunnel').addEventListener('click', openTunnels);
  // Menu Công cụ: các module tự đăng ký mục của mình qua bus.provide('tools-menu').
  $('#btn-tools').addEventListener('click', (e) =>
    showMenuAt(e.currentTarget, [...bus.collect('tools-menu'), '-', { icon: 'import', label: 'Import session từ MobaXterm…', action: openImport }])
  );
  $('#btn-multiexec').addEventListener('click', () => setMultiExec(!state.multiExec));
  $('#tabbar .tab.home').addEventListener('click', () => activate('home'));
  // Nút "+" cạnh các tab: mở nhanh session, terminal local hoặc kết nối nhanh.
  $('#tab-add').addEventListener('click', (e) =>
    showMenuAt(e.currentTarget, [
      { icon: 'server-plus', label: 'Session mới…', action: () => editSession() },
      { icon: 'restore', label: 'Mở lại tab vừa đóng (Ctrl+Shift+T)', disabled: !closedTabItems().length, action: () => reopenTab() },
      ...(state.capabilities.localFeatures ? (state.shells || []).map((s) => ({ icon: 'terminal', label: s.name, action: () => openLocal(s) })) : []),
      '-',
      { icon: 'zap', label: 'Kết nối nhanh…', action: () => $('#quick-input').focus() },
    ])
  );
  // Thanh dọc bên trái: bấm lại mục đang mở để thu gọn thanh bên (giống VS Code).
  $$('.side-tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      const active = b.classList.contains('active');
      if (active && sidebarShown()) return setSidebar(false);
      if (!sidebarShown()) setSidebar(true);
      switchSide(b.dataset.side);
    })
  );

  $('#quick-connect').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#quick-input');
    const q = parseQuick(input.value);
    if (!q) return toast('Định dạng: user@host:port (vd. root@1.2.3.4:22)', 'error');
    new TermTab({ kind: 'ssh', name: `${q.username ? q.username + '@' : ''}${q.host}${q.port !== 22 ? ':' + q.port : ''}`, ...q, auth: 'password', hasPassword: false });
    input.value = '';
  });
}

async function boot() {
  hydrateIcons();
  initToolbar();
  initSessions();
  initImport();
  initSftp();
  initEditor();
  initSettings();
  initLayout();
  initMacros();
  initLocal();
  initKeygen();
  initVault();
  initBackup();
  initPortable();
  initTabHistory();
  initTabNavigation();
  initCommands();
  bus.on('side', (name) => {
    if (!sidebarShown() && !narrow()) setSidebar(true);
    switchSide(name);
  });
  bus.on('locked-out', showLocked);

  try {
    state.capabilities = await api('GET', '/api/capabilities');
  } catch (e) {
    if (e.status === 401) return showLocked(e.message);
  }
  document.body.classList.toggle('no-local', !state.capabilities.localFeatures);
  if (state.capabilities.windowsBuild) state.windowsPty = { backend: 'conpty', buildNumber: state.capabilities.windowsBuild };
  bus.emit('capabilities', state.capabilities);
  connectServerEvents();
  await loadSettings();
  await loadShells();
  await loadSessions();
  await loadMacros();
  initTunnels();
  renderStatus();
  state.ready = true;
  bus.emit('ready');
}

// Nhắc trước khi đóng trình duyệt khi còn phiên đang mở (Ctrl+W trong bash dễ bấm nhầm).
window.addEventListener('beforeunload', (e) => {
  if ([...tabs.values()].some((t) => t.status === 'connected') || bus.collect('unsaved-changes').length) {
    e.preventDefault();
    e.returnValue = '';
  }
});

boot();
