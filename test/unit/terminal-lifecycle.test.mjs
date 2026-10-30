import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Dùng module giao diện thật với DOM/WebSocket nhỏ, điều khiển được thời điểm đóng hộp thoại.
class Element extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {} };
    this.attributes = new Map();
    this.open = false;
    this.showCount = 0;
    this.removed = 0;
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  setAttribute(name, value) { this.attributes.set(name, value); this[name] = value; }
  getAttribute(name) { return this.attributes.get(name); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  descendants() { return this.children.filter((x) => x instanceof Element).flatMap((x) => [x, ...x.descendants()]); }
  querySelector() { return this.descendants().find((x) => ['input', 'textarea'].includes(x.tagName) && x.type !== 'checkbox') || null; }
  querySelectorAll() { return []; }
  showModal() { assert.equal(this.open, false); this.open = true; this.showCount++; }
  close(value = '') {
    if (!this.open) return;
    this.open = false;
    this.returnValue = value;
    // HTMLDialogElement phát close sau khi close() đã trả về.
    queueMicrotask(() => this.dispatchEvent(new Event('close')));
  }
  focus() {}
  select() {}
  remove() { this.removed++; }
}

const nodes = new Map();
const node = (selector) => {
  if (!nodes.has(selector)) nodes.set(selector, new Element(selector.includes('dlg-') ? 'dialog' : 'div'));
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
globalThis.location = { protocol: 'http:', host: 'localhost:3366' };
const frames = new Map();
let frameSeq = 0;
globalThis.requestAnimationFrame = (fn) => { frames.set(++frameSeq, fn); return frameSeq; };
globalThis.cancelAnimationFrame = (id) => frames.delete(id);

class Socket {
  static OPEN = 1;
  static instances = [];
  constructor() { this.readyState = 0; this.sent = []; this.closeCount = 0; Socket.instances.push(this); }
  open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); }
  close() { this.closeCount++; this.readyState = 3; this.onclose?.(); }
}
globalThis.WebSocket = Socket;

const { TermTab } = await import('../../public/js/term/tab.js');
const { state, tabs } = await import('../../public/js/state.js');
const settle = () => new Promise((resolve) => setImmediate(resolve));
let seq = 0;

function makeTab(target = { kind: 'local', name: 'Local', shell: 'powershell' }) {
  const tab = Object.assign(Object.create(TermTab.prototype), {
    key: `test-${++seq}`, target, status: 'error', connId: null, ws: null,
    connectAttempt: null, disposed: false, creds: {}, forcePrompt: false,
    stats: null, statsUnsupported: false, monitorOn: false, multi: true,
    sftp: {}, tabEl: new Element(), paneEl: new Element(),
    hostEl: { clientWidth: 800, clientHeight: 400 },
    fit: { fit() {} }, resizeObs: { count: 0, disconnect() { this.count++; } },
    term: {
      cols: 80, rows: 24, writes: [], disposeCount: 0,
      write(data) { this.writes.push(data); }, focus() {},
      dispose() { this.disposeCount++; },
    },
  });
  tabs.set(tab.key, tab);
  return tab;
}

const passwordTarget = () => ({ kind: 'ssh', name: 'SSH', username: 'root', host: 'example.test', port: 22, auth: 'password', hasPassword: false });
const enter = (name, value) => {
  const input = node('#prompt-fields').descendants().find((x) => x.name === name);
  assert.ok(input, `Thiếu trường ${name}`);
  input.value = value;
};

afterEach(async () => {
  state.activeKey = 'home';
  for (const tab of [...tabs.values()]) tab.close();
  for (const element of nodes.values()) if (element.open) element.close('cancel');
  await settle();
  nodes.clear();
  Socket.instances = [];
  frames.clear();
});

test('nhấn R liên tiếp khi hỏi mật khẩu chỉ tạo một lần đăng nhập', async () => {
  const tab = makeTab(passwordTarget());
  tab.input('r');
  const attempt = tab.connectAttempt;
  assert.equal(tab.status, 'connecting');
  tab.input('R');
  assert.equal(tab.connectAttempt, attempt);
  await settle();
  assert.equal(node('#dlg-prompt').showCount, 1);
  enter('password', 'correct-password');
  node('#dlg-prompt').close('ok');
  await settle();
  assert.equal(Socket.instances.length, 1);
  tab.ws.open();
  assert.equal(tab.ws.sent[0].password, 'correct-password');
});

test('kết nối lại huỷ hộp thoại cũ và không tạo socket từ mật khẩu cũ', async () => {
  const tab = makeTab(passwordTarget());
  const first = tab.connect();
  await settle();
  const oldAttempt = tab.connectAttempt;
  enter('password', 'old-password');
  // Người dùng vừa gửi hộp thoại nhưng callback promise chưa chạy.
  node('#dlg-prompt').close('ok');
  tab.reconnect();
  await first;
  await settle();
  assert.equal(oldAttempt.signal.aborted, true);
  assert.equal(Socket.instances.length, 0);
  assert.equal(node('#dlg-prompt').open, true);
  enter('password', 'new-password');
  node('#dlg-prompt').close('ok');
  await settle();
  assert.equal(Socket.instances.length, 1);
  tab.ws.open();
  assert.equal(tab.ws.sent[0].password, 'new-password');
});

test('xác nhận host key cũ không gửi sang socket mới', async () => {
  const tab = makeTab();
  await tab.connect();
  const oldSocket = tab.ws;
  oldSocket.open();
  const lateMessage = oldSocket.onmessage;
  const pending = tab.onControl({ type: 'hostkey', host: 'example.test', port: 22, fingerprint: 'SHA256:test', keyType: 'ssh-ed25519' });
  await settle();
  node('#dlg-hostkey').close('accept');
  tab.reconnect();
  const currentSocket = tab.ws;
  currentSocket.open();
  await pending;
  lateMessage({ data: JSON.stringify({ type: 'ready', id: 'stale-connection' }) });
  assert.equal(oldSocket.closeCount, 1);
  assert.equal(tab.connId, null);
  assert.deepEqual(currentSocket.sent.map((x) => x.type), ['connect']);
});

test('mật khẩu jump host vừa gửi không cập nhật lần kết nối đã thay thế', async () => {
  const tab = makeTab();
  await tab.connect();
  tab.ws.open();
  const pending = tab.onAsk({ type: 'ask', id: 'old-secret', kind: 'secret', hop: 'bastion' });
  await settle();
  enter('a0', 'secret-for-old-connection');
  node('#dlg-prompt').close('ok');
  tab.reconnect();
  tab.ws.open();
  await pending;
  assert.equal(tab.creds.jumpPassword, undefined);
  assert.deepEqual(tab.ws.sent.map((x) => x.type), ['connect']);
});

test('đóng tab huỷ đăng nhập và frame đang chờ, gọi đóng hai lần an toàn', async () => {
  const tab = makeTab(passwordTarget());
  const pending = tab.connect();
  await settle();
  tab.scheduleFit();
  assert.equal(frames.size, 1);
  tab.close();
  tab.close();
  await pending;
  assert.equal(node('#dlg-prompt').open, false);
  assert.equal(frames.size, 0);
  assert.equal(tab.term.disposeCount, 1);
  assert.equal(tab.resizeObs.count, 1);
  assert.equal(tab.tabEl.removed, 1);
  assert.equal(tabs.has(tab.key), false);
  assert.equal(Socket.instances.length, 0);
  tab.reconnect();
  tab.scheduleFit();
  assert.equal(Socket.instances.length, 0);
  assert.equal(frames.size, 0);
});

test('đóng tab đang xếp hàng không hiện hộp thoại mật khẩu sau đó', async () => {
  const firstTab = makeTab(passwordTarget());
  const closedTab = makeTab(passwordTarget());
  const first = firstTab.connect();
  const pending = closedTab.connect();
  await settle();
  closedTab.close();
  enter('password', 'first-tab-password');
  node('#dlg-prompt').close('ok');
  await Promise.all([first, pending]);
  assert.equal(node('#dlg-prompt').showCount, 1);
  assert.equal(node('#dlg-prompt').open, false);
  assert.equal(Socket.instances.length, 1);
  assert.equal(closedTab.ws, null);
});

test('lỗi kết nối dọn dữ liệu giám sát và giữ trạng thái error khi socket đóng', async () => {
  const tab = makeTab();
  await tab.connect();
  const ws = tab.ws;
  ws.open();
  const lateClose = ws.onclose;
  tab.status = 'connected';
  tab.connId = 'old';
  tab.monitorOn = true;
  tab.stats = { cpu: 100 };
  tab.statsUnsupported = true;
  await tab.onControl({ type: 'error', code: 'auth', message: 'Login failed' });
  lateClose();
  assert.equal(tab.status, 'error');
  assert.equal(tab.connId, null);
  assert.equal(tab.stats, null);
  assert.equal(tab.statsUnsupported, false);
  assert.equal(tab.monitorOn, false);
  assert.equal(ws.closeCount, 1);
  assert.equal(tab.forcePrompt, true);
});

test('nhiều câu hỏi OTP giữ đúng thứ tự khi có hơn mười trường', async () => {
  const tab = makeTab();
  await tab.connect();
  tab.ws.open();
  const prompts = Array.from({ length: 12 }, (_, i) => ({ prompt: `OTP ${i}`, echo: false }));
  const pending = tab.onAsk({ type: 'ask', id: 'otp', kind: 'keyboard-interactive', prompts });
  await settle();
  for (let i = 0; i < prompts.length; i++) enter(`a${i}`, `value-${i}`);
  node('#dlg-prompt').close('ok');
  await pending;
  assert.deepEqual(tab.ws.sent.at(-1).values, prompts.map((_, i) => `value-${i}`));
});
