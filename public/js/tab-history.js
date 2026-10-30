// Chỉ nhớ cấu hình mở tab trong bộ nhớ; không giữ mật khẩu, OTP hay nội dung terminal.
import { toast } from './core/dom.js';
import { state, bus } from './state.js';
import { TermTab } from './term/tab.js';
import { openSession } from './sessions.js';
import { targetLabel } from './core/format.js';

const TARGET_FIELDS = ['kind', 'sessionId', 'name', 'host', 'port', 'username', 'auth', 'hasPassword', 'color', 'startDir', 'shell', 'windowsPty'];
const history = [];
let seq = 0;

export function rememberTab(tab) {
  if (tab.initializationFailed) return;
  const target = {};
  for (const field of TARGET_FIELDS) if (field !== 'windowsPty' && tab.target[field] !== undefined) target[field] = tab.target[field];
  if (tab.target.windowsPty) target.windowsPty = { backend: tab.target.windowsPty.backend, buildNumber: tab.target.windowsPty.buildNumber };
  if (tab.creds?.username) target.username = tab.creds.username;
  history.unshift({ id: `closed-${++seq}`, name: tab.nameEl.textContent, target });
  history.splice(10);
  bus.emit('tab-history-changed');
}

export function reopenTab(id = history[0]?.id) {
  const index = history.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const [item] = history.splice(index, 1);
  bus.emit('tab-history-changed');
  const saved = item.target.sessionId && state.sessions.find((s) => s.id === item.target.sessionId);
  if (item.target.sessionId && !saved) {
    toast('Session của tab này đã bị xoá. Hãy tạo session mới để kết nối.', 'error');
    return null;
  }
  const kind = saved ? saved.type || 'ssh' : item.target.kind;
  if (kind === 'rdp') {
    toast('Session đã đổi sang RDP. Hãy mở từ danh sách Sessions.', 'error');
    return null;
  }
  if (kind === 'local' && !state.capabilities.localFeatures) {
    toast('Terminal local không khả dụng trong kết nối này.', 'error');
    return null;
  }
  try {
    const tab = saved ? openSession(saved) : new TermTab({ ...item.target, name: item.name });
    if (tab && tab.nameEl.textContent !== item.name) tab.setName(item.name);
    return tab;
  } catch (e) {
    history.splice(index, 0, item);
    bus.emit('tab-history-changed');
    throw e;
  }
}

export const closedTabItems = () => history.map((item) => ({
  id: item.id,
  label: item.name,
  detail: item.target.kind === 'local' ? 'Terminal local · Kết nối mới' : `${targetLabel(item.target.username, item.target.host, item.target.port)} · Kết nối mới`,
  icon: item.target.kind === 'local' ? 'terminal' : 'server',
  action: () => reopenTab(item.id),
}));

export function initTabHistory() {
  bus.on('tab-closed', rememberTab);
  bus.provide('closed-tabs', closedTabItems);
  bus.provide('tools-menu', () => [{ icon: 'restore', label: 'Mở lại tab vừa đóng', disabled: !history.length, action: () => reopenTab() }]);
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== 't' || e.isComposing || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    e.stopPropagation();
    reopenTab();
  }, true);
}
