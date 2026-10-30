import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Module SFTP thật, DOM tối thiểu và HTTP điều khiển được thứ tự trả về.
class Element extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.replacements = 0;
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.replacements++; }
  focus() {}
  select() {}
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

const { sftpLoad, initSftp } = await import('../../public/js/sftp.js');
const { state, tabs, bus } = await import('../../public/js/state.js');
bus.provide('all-tabs', () => [...tabs.values()]);
initSftp();

let requests;
let seq = 0;
const settle = () => new Promise((resolve) => setImmediate(resolve));
const entry = (name) => ({ name, type: '-', size: 10, perms: 'rw-r--r--', mtime: 1, mode: 0o644 });
const succeed = (request, path, names = []) => request.resolve({ ok: true, json: async () => ({ path, entries: names.map(entry) }) });
function makeTab(cwd = '/original') {
  const tab = {
    key: `sftp-${++seq}`, status: 'connected', connId: 'connection-1', disposed: false,
    target: { kind: 'ssh' }, control() {},
    sftp: { cwd, entries: [entry('original.txt')], selected: new Set(['original.txt']), anchor: 'original.txt', loading: false, error: null, follow: false },
  };
  tabs.set(tab.key, tab);
  state.activeKey = tab.key;
  return tab;
}

beforeEach(() => {
  requests = [];
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    requests.push({ url, body: JSON.parse(options.body), resolve, reject });
  });
  for (const element of nodes.values()) {
    element.children = [];
    element.replacements = 0;
    element.textContent = '';
  }
});
afterEach(() => {
  tabs.clear();
  state.activeKey = 'home';
});

test('SFTP: kết quả chuyển thư mục cũ không ghi đè lần chuyển mới hơn', async () => {
  const tab = makeTab();
  const first = sftpLoad(tab, '/slow');
  const latest = sftpLoad(tab, '/latest');
  succeed(requests[1], '/latest', ['latest.txt']);
  await latest;
  assert.equal(tab.sftp.cwd, '/latest');
  assert.equal(tab.sftp.loading, false);
  const entries = tab.sftp.entries;
  const renders = node('#sftp-list').replacements;
  tab.sftp.selected.add('latest.txt');
  tab.sftp.anchor = 'latest.txt';
  succeed(requests[0], '/slow', ['old.txt']);
  await first;
  assert.equal(tab.sftp.entries, entries);
  assert.equal(tab.sftp.cwd, '/latest');
  assert.deepEqual([...tab.sftp.selected], ['latest.txt']);
  assert.equal(tab.sftp.anchor, 'latest.txt');
  assert.equal(node('#sftp-list').replacements, renders, 'không render lại từ HTTP cũ');
});

test('SFTP: yêu cầu cũ xong sớm không tắt loading của yêu cầu mới', async () => {
  const tab = makeTab();
  const first = sftpLoad(tab, '/slow');
  const latest = sftpLoad(tab, '/latest');
  succeed(requests[0], '/slow', ['old.txt']);
  await first;
  assert.equal(tab.sftp.cwd, '/original');
  assert.equal(tab.sftp.loading, true);
  assert.deepEqual([...tab.sftp.selected], ['original.txt']);
  succeed(requests[1], '/latest');
  await latest;
  assert.equal(tab.sftp.loading, false);
  assert.equal(tab.sftp.selected.size, 0);
});

test('SFTP: lỗi cũ không hiện thông báo hay khởi chạy fallback sau thao tác mới', async () => {
  const tab = makeTab(null);
  const first = sftpLoad(tab, '/missing');
  const latest = sftpLoad(tab, '/latest');
  requests[0].reject(new Error('Lỗi từ kết nối cũ'));
  await first;
  assert.equal(requests.length, 2);
  assert.equal(tab.sftp.error, null);
  assert.equal(tab.sftp.loading, true);
  assert.equal(node('#toasts').children.length, 0);
  succeed(requests[1], '/latest');
  await latest;
});

test('SFTP: fallback giữ loading và không ghi đè đường dẫn mới hơn', async () => {
  const tab = makeTab(null);
  const first = sftpLoad(tab, '/missing');
  requests[0].reject(new Error('Không tồn tại'));
  await settle();
  assert.equal(requests[1].body.path, '.');
  assert.equal(tab.sftp.loading, true);
  const latest = sftpLoad(tab, '/latest');
  succeed(requests[2], '/latest', ['latest.txt']);
  await latest;
  succeed(requests[1], '/home/user', ['old.txt']);
  await first;
  assert.equal(requests.length, 3);
  assert.equal(tab.sftp.cwd, '/latest');
  assert.deepEqual(tab.sftp.entries.map((e) => e.name), ['latest.txt']);
});

test('SFTP: fallback thất bại kết thúc loading và cho phép thử lại', async () => {
  const tab = makeTab(null);
  const pending = sftpLoad(tab, '/missing');
  requests[0].reject(new Error('Không tồn tại'));
  await settle();
  requests[1].reject(new Error('Không mở được thư mục nhà'));
  await pending;
  assert.equal(tab.sftp.loading, false);
  assert.equal(tab.sftp.error, 'Không mở được thư mục nhà');
  const retry = sftpLoad(tab, '.');
  succeed(requests[2], '/home/user');
  await retry;
  assert.equal(tab.sftp.cwd, '/home/user');
  assert.equal(tab.sftp.error, null);
});

test('SFTP: reconnect bỏ kết quả của connId cũ và giữ loading kết nối mới', async () => {
  const tab = makeTab();
  const old = sftpLoad(tab, '/old');
  tab.connId = 'connection-2';
  tab.sftp = { ...tab.sftp, cwd: null, entries: [], selected: new Set(), anchor: null, loading: false };
  const current = tab.sftp;
  const latest = sftpLoad(tab, '/new');
  assert.match(requests[0].url, /connection-1\/list$/);
  assert.match(requests[1].url, /connection-2\/list$/);
  succeed(requests[0], '/old', ['old.txt']);
  await old;
  assert.equal(current.cwd, null);
  assert.equal(current.loading, true);
  succeed(requests[1], '/new', ['new.txt']);
  await latest;
  assert.equal(current.cwd, '/new');
});

test('SFTP: thay đối tượng SFTP vô hiệu yêu cầu cũ dù connId chưa đổi', async () => {
  const tab = makeTab();
  const pending = sftpLoad(tab, '/old');
  tab.sftp = { ...tab.sftp, cwd: '/restored', entries: [], loading: false };
  const current = tab.sftp;
  const renders = node('#sftp-list').replacements;
  succeed(requests[0], '/old', ['old.txt']);
  await pending;
  assert.equal(current.cwd, '/restored');
  assert.deepEqual(current.entries, []);
  assert.equal(current.loading, false);
  assert.equal(node('#sftp-list').replacements, renders);
});

test('SFTP: tab đã đóng bỏ HTTP đang chờ và không gửi yêu cầu mới', async () => {
  const tab = makeTab();
  const pending = sftpLoad(tab, '/old');
  tab.disposed = true;
  tab.status = 'closed';
  tab.connId = null;
  const renders = node('#sftp-list').replacements;
  requests[0].reject(new Error('Mất kết nối'));
  await pending;
  await sftpLoad(tab, '/new');
  assert.equal(requests.length, 1);
  assert.equal(tab.sftp.cwd, '/original');
  assert.equal(node('#toasts').children.length, 0);
  assert.equal(node('#sftp-list').replacements, renders);
});

test('SFTP: refresh giữ mục còn tồn tại và bỏ anchor đã bị xoá', async () => {
  const tab = makeTab();
  tab.sftp.selected.add('deleted.txt');
  tab.sftp.anchor = 'deleted.txt';
  const pending = sftpLoad(tab, '/original', { keepSelection: true });
  succeed(requests[0], '/original', ['original.txt', 'new.txt']);
  await pending;
  assert.deepEqual([...tab.sftp.selected], ['original.txt']);
  assert.equal(tab.sftp.anchor, null);
});

test('SFTP: keepSelection vẫn xoá lựa chọn khi chuyển thư mục', async () => {
  const tab = makeTab();
  const pending = sftpLoad(tab, '/other', { keepSelection: true });
  succeed(requests[0], '/other', ['original.txt']);
  await pending;
  assert.equal(tab.sftp.selected.size, 0);
  assert.equal(tab.sftp.anchor, null);
});

test('SFTP: follow quay về cwd hiện tại huỷ ý định cũ và gộp thông báo trùng', async () => {
  const tab = makeTab();
  tab.sftp.follow = true;
  const manual = sftpLoad(tab, '/manual');
  bus.emit('osc-cwd', { tab, path: '/original' });
  bus.emit('osc-cwd', { tab, path: '/original' });
  assert.equal(requests.length, 2, 'không tạo thêm list cho cùng đường dẫn đang tải');
  assert.equal(requests[1].body.path, '/original');
  succeed(requests[0], '/manual');
  await manual;
  assert.equal(tab.sftp.cwd, '/original');
  assert.equal(tab.sftp.loading, true);
  succeed(requests[1], '/original', ['follow.txt']);
  await settle();
  assert.equal(tab.sftp.cwd, '/original');
  assert.equal(tab.sftp.loading, false);
  bus.emit('osc-cwd', { tab, path: '/original' });
  assert.equal(requests.length, 2);
});

test('SFTP: trả lời nút Home chậm không khởi chạy list đè lên thao tác mới', async () => {
  const tab = makeTab();
  const toolbar = node('#side-sftp .sftp-toolbar');
  toolbar.closest = () => ({ dataset: { sftp: 'home' } });
  toolbar.dispatchEvent(new Event('click'));
  assert.match(requests[0].url, /\/home$/);
  const latest = sftpLoad(tab, '/latest');
  succeed(requests[0], '/home/user');
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(tab.sftp.loading, true);
  succeed(requests[1], '/latest');
  await latest;
  assert.equal(tab.sftp.cwd, '/latest');
});
