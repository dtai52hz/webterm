import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Dùng module thật; terminal giả chỉ bỏ kết nối/màn hình để kiểm tra dữ liệu mở lại.
class Element extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {} };
    this.classList = { toggle() {}, add() {}, remove() {} };
    this.clientWidth = 800;
    this.clientHeight = 400;
    this.textContent = '';
  }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  focus() { document.activeElement = this; }
  scrollIntoView() {}
  remove() {}
}
const nodes = new Map();
const node = (selector) => {
  if (!nodes.has(selector)) nodes.set(selector, new Element());
  return nodes.get(selector);
};
globalThis.Node = Element;
globalThis.document = Object.assign(new EventTarget(), {
  querySelector: node,
  querySelectorAll: () => [],
  createElement: (tag) => new Element(tag),
  createElementNS: (_ns, tag) => new Element(tag),
});
globalThis.window = new EventTarget();
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, value),
};
class FakeTerminal {
  options = {};
  cols = 80;
  rows = 24;
  parser = { registerOscHandler() {} };
  loadAddon() {}
  open() {}
  attachCustomKeyEventHandler() {}
  onData() {}
  onBinary() {}
  onSelectionChange() {}
  onTitleChange() {}
  focus() {}
  dispose() {}
}
globalThis.Terminal = FakeTerminal;
globalThis.FitAddon = { FitAddon: class { fit() {} } };
globalThis.WebLinksAddon = { WebLinksAddon: class {} };
globalThis.SearchAddon = { SearchAddon: class { onDidChangeResults() {} } };

const { TermTab } = await import('../../public/js/term/tab.js');
TermTab.prototype.connect = async function () {};
const { state, tabs } = await import('../../public/js/state.js');
const { rememberTab, reopenTab, closedTabItems } = await import('../../public/js/tab-history.js');
const closed = (target, name = target.name || 'Closed tab') => ({
  target, nameEl: { textContent: name },
  creds: { password: 'credential-password', jumpPassword: 'jump-secret', otp: '123456' },
  term: { contents: 'sensitive terminal scrollback' },
});
const ssh = (extra = {}) => ({ kind: 'ssh', name: 'SSH', host: 'old.example.test', port: 22, username: 'old-user', auth: 'password', ...extra });

afterEach(() => {
  state.sessions = [];
  state.capabilities.localFeatures = true;
  for (const item of closedTabItems()) reopenTab(item.id);
  for (const tab of [...tabs.values()]) tab.close();
  state.activeKey = 'home';
  stored.clear();
  node('#tabbar').children = [];
  node('#panes').children = [];
});

test('lịch sử tab: chỉ giữ cấu hình cho phép, không giữ bí mật hay tham chiếu windowsPty', () => {
  const original = ssh({
    password: 'target-password', passphrase: 'private-key-passphrase',
    privateKey: 'private-key-material', privateKeyPath: 'secret/key/path',
    jumpPassword: 'target-jump-secret', otp: '654321',
    creds: { password: 'nested-password' }, loginCommand: 'export TOKEN=secret',
    windowsPty: { backend: 'conpty', buildNumber: 22631, password: 'nested-secret' },
  });
  rememberTab(closed(original, 'Renamed tab'));
  original.host = 'changed.example.test';
  original.windowsPty.buildNumber = 99999;
  const opened = reopenTab();
  assert.deepEqual(opened.target, {
    kind: 'ssh', name: 'Renamed tab', host: 'old.example.test', port: 22,
    username: 'old-user', auth: 'password',
    windowsPty: { backend: 'conpty', buildNumber: 22631 },
  });
  assert.deepEqual(opened.creds, {});
  assert.equal(JSON.stringify(opened.target).includes('secret'), false);
  assert.equal(stored.size, 0, 'lịch sử tab không được ghi vào localStorage');
});

test('lịch sử tab: chỉ giữ 10 tab gần nhất theo thứ tự mới nhất trước', () => {
  for (let i = 0; i < 12; i++) rememberTab(closed(ssh(), `Tab ${i}`));
  const items = closedTabItems();
  assert.equal(items.length, 10);
  assert.deepEqual(items.map((item) => item.label), Array.from({ length: 10 }, (_, i) => `Tab ${11 - i}`));
  assert.equal(new Set(items.map((item) => item.id)).size, 10);
  const opened = items[2].action();
  assert.equal(opened.nameEl.textContent, 'Tab 9');
  assert.equal(closedTabItems().length, 9);
  assert.equal(reopenTab(items[2].id), null, 'mục đã mở không được mở thêm lần nữa');
});

test('lịch sử tab: nhớ username đã nhập khi kết nối nhanh mà không giữ mật khẩu', () => {
  const tab = closed(ssh({ username: '' }));
  tab.creds.username = 'entered-user';
  rememberTab(tab);
  const opened = reopenTab();
  assert.equal(opened.target.username, 'entered-user');
  assert.deepEqual(opened.creds, {});
  assert.equal(opened.target.password, undefined);
});

test('lịch sử tab: session lưu được tra lại cấu hình mới nhất nhưng giữ tên tab riêng', () => {
  rememberTab(closed(ssh({ sessionId: 'saved-1', hasPassword: false }), 'Custom deployment tab'));
  state.sessions = [{
    id: 'saved-1', name: 'Updated session', type: 'ssh', host: 'new.example.test',
    port: 2222, username: 'new-user', auth: 'key', hasPassword: true,
    password: 'server-only-secret', privateKey: 'server-only-key',
  }];
  const opened = reopenTab();
  assert.equal(opened.target.sessionId, 'saved-1');
  assert.equal(opened.target.host, 'new.example.test');
  assert.equal(opened.target.port, 2222);
  assert.equal(opened.target.username, 'new-user');
  assert.equal(opened.target.auth, 'key');
  assert.equal(opened.nameEl.textContent, 'Custom deployment tab');
  assert.equal(opened.target.password, undefined);
  assert.equal(opened.target.privateKey, undefined);
});

test('lịch sử tab: session đã xoá không được kết nối bằng cấu hình cũ', () => {
  rememberTab(closed(ssh({ sessionId: 'deleted-session' })));
  state.sessions = [];
  const before = tabs.size;
  assert.equal(reopenTab(), null);
  assert.equal(tabs.size, before);
  assert.equal(closedTabItems().length, 0);
});

test('lịch sử tab: kiểm tra khả năng local theo kiểu session hiện tại', () => {
  state.capabilities.localFeatures = false;
  rememberTab(closed({ kind: 'local', sessionId: 'changed-ssh', name: 'Old local', shell: 'powershell' }));
  state.sessions = [{ id: 'changed-ssh', type: 'ssh', name: 'Now SSH', host: 'remote.test', username: 'user', auth: 'password' }];
  assert.equal(reopenTab()?.target.kind, 'ssh', 'local đã đổi thành SSH được mở qua mạng');

  rememberTab(closed(ssh({ sessionId: 'changed-local' })));
  state.sessions = [{ id: 'changed-local', type: 'local', name: 'Now local', shell: 'powershell' }];
  const before = tabs.size;
  assert.equal(reopenTab(), null, 'SSH đã đổi thành local bị chặn khi thiếu khả năng local');
  assert.equal(tabs.size, before);
});

test('lịch sử tab: session đổi thành RDP không tự khởi chạy Remote Desktop', () => {
  rememberTab(closed(ssh({ sessionId: 'changed-rdp' })));
  state.sessions = [{ id: 'changed-rdp', type: 'rdp', name: 'Now RDP', host: 'rdp.test' }];
  const before = stored.size;
  assert.equal(reopenTab(), null);
  assert.equal(tabs.size, 0);
  assert.equal(stored.size, before, 'không gọi openSession cho session RDP');
});

test('lịch sử tab: lỗi tạo terminal trả mục về đúng vị trí để thử lại', () => {
  rememberTab(closed(ssh(), 'Older'));
  rememberTab(closed(ssh(), 'Newer'));
  const before = closedTabItems().map(({ id, label }) => ({ id, label }));
  const TerminalClass = globalThis.Terminal;
  globalThis.Terminal = class { constructor() { throw new Error('Terminal initialization failed'); } };
  try {
    assert.throws(() => reopenTab(before[1].id), /Terminal initialization failed/);
    assert.deepEqual(closedTabItems().map(({ id, label }) => ({ id, label })), before);
    assert.equal(tabs.size, 0, 'không còn tab tạo dở sau lỗi khởi tạo');
  } finally {
    globalThis.Terminal = TerminalClass;
  }
});
