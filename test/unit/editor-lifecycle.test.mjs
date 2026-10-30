import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Module trình soạn thảo thật; chủ động giữ phản hồi HTTP để tái hiện các race.
class Element extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag;
    this.children = [];
    this.value = '';
    this.textContent = '';
    this.open = false;
    this.showCount = 0;
    this.style = {};
  }
  setAttribute(name, value) { this[name] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelector() { return null; }
  showModal() { assert.equal(this.open, false); this.open = true; this.showCount++; }
  close(value = '') {
    if (!this.open) return;
    this.open = false;
    this.returnValue = value;
    queueMicrotask(() => this.dispatchEvent(new Event('close')));
  }
  focus() {}
  setSelectionRange() {}
  remove() {}
}

const nodes = new Map();
const node = (selector) => {
  if (!nodes.has(selector)) nodes.set(selector, new Element());
  return nodes.get(selector);
};
globalThis.Node = Element;
globalThis.document = {
  querySelector: node,
  createElement: (tag) => new Element(tag),
  createElementNS: (_ns, tag) => new Element(tag),
};
let requests = [];
globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
  const request = { url, body: JSON.parse(options.body), done: false };
  request.respond = (data, status = 200) => {
    request.done = true;
    resolve({ ok: status < 400, status, json: async () => data });
  };
  request.reject = (error) => { request.done = true; reject(error); };
  requests.push(request);
});
const { openEditor, initEditor } = await import('../../public/js/editor.js');
const { bus } = await import('../../public/js/state.js');
initEditor();
const settle = () => new Promise((resolve) => setImmediate(resolve));
const tab = () => ({ connId: 'connection-1', disposed: false });
const unsaved = () => bus.collect('unsaved-changes');
const input = (value) => {
  node('#editor-text').value = value;
  node('#editor-text').dispatchEvent(new Event('input'));
};
const submit = (value) => {
  const event = new Event('submit', { cancelable: true });
  event.submitter = { value };
  node('#editor-form').dispatchEvent(event);
};
const saveKey = () => {
  const event = new Event('keydown', { cancelable: true });
  Object.assign(event, { key: 's', ctrlKey: true });
  node('#editor-text').dispatchEvent(event);
};
async function open(content = 'original\n', source = tab(), path = '/file.txt') {
  const pending = openEditor(source, path);
  requests.at(-1).respond({ content });
  await pending;
  return source;
}

afterEach(async () => {
  for (const request of requests) if (!request.done) request.reject(new Error('test cleanup'));
  await settle();
  if (node('#dlg-prompt').open) node('#dlg-prompt').close('ok');
  await settle();
  submit('close');
  await settle();
  if (node('#dlg-prompt').open) node('#dlg-prompt').close('ok');
  await settle();
  assert.equal(node('#dlg-editor').open, false);
  requests = [];
  for (const element of nodes.values()) element.showCount = 0;
});

test('editor: gõ tiếp trong lúc lưu giữ trạng thái chưa lưu và định dạng CRLF', async () => {
  await open('original\r\n');
  input('sent\n');
  submit('save');
  const write = requests.at(-1);
  assert.equal(write.body.content, 'sent\r\n');
  assert.equal(node('#editor-save').disabled, true);
  input('newer\n');
  assert.equal(node('#editor-state').textContent, 'Đang lưu…');
  write.respond({ ok: true });
  await settle();
  assert.equal(node('#editor-text').value, 'newer\n');
  assert.equal(node('#editor-state').textContent, '● Chưa lưu');
  assert.equal(node('#editor-save').disabled, false);
  assert.deepEqual(unsaved(), [{ kind: 'editor', path: '/file.txt' }]);
  submit('save');
  assert.equal(requests.at(-1).body.content, 'newer\r\n');
  requests.at(-1).respond({ ok: true });
  await settle();
  assert.equal(node('#editor-state').textContent, '✓ Đã lưu');
  assert.deepEqual(unsaved(), []);
});

test('editor: Ctrl+S liên tiếp chỉ ghi một request, unload vẫn được bảo vệ khi đang lưu', async () => {
  await open();
  saveKey();
  saveKey();
  submit('save');
  assert.equal(requests.filter((r) => r.url.endsWith('/write')).length, 1);
  assert.equal(unsaved().length, 1, 'đang lưu nội dung sạch vẫn không được rời trang');
  requests.at(-1).respond({ ok: true });
  await settle();
  assert.deepEqual(unsaved(), []);
});

test('editor: phản hồi đọc đảo thứ tự chỉ mở file được yêu cầu cuối cùng', async () => {
  const source = tab();
  const first = openEditor(source, '/first.txt');
  const firstRequest = requests.at(-1);
  const second = openEditor(source, '/second.txt');
  requests.at(-1).respond({ content: 'second' });
  await second;
  firstRequest.respond({ content: 'first' });
  await first;
  assert.equal(node('#editor-title').textContent, '/second.txt');
  assert.equal(node('#editor-text').value, 'second');
  assert.equal(node('#dlg-editor').showCount, 1);
});

test('editor: mở file khác phải xác nhận bỏ bản chưa lưu, huỷ thì giữ nguyên', async () => {
  const source = await open();
  input('unsaved');
  const other = openEditor(source, '/other.txt');
  requests.at(-1).respond({ content: 'other' });
  await settle();
  assert.equal(node('#dlg-prompt').open, true);
  node('#dlg-prompt').close('cancel');
  await other;
  assert.equal(node('#editor-text').value, 'unsaved');
  assert.equal(node('#editor-title').textContent, '/file.txt');

  const accepted = openEditor(source, '/other.txt');
  requests.at(-1).respond({ content: 'other' });
  await settle();
  node('#dlg-prompt').close('ok');
  await accepted;
  assert.equal(node('#editor-text').value, 'other');
  assert.equal(node('#dlg-editor').showCount, 1, 'tái dùng dialog đang mở an toàn');
});

test('editor: đóng đợi lần lưu xong, bản gõ sau đó vẫn cần xác nhận', async () => {
  await open();
  input('sent');
  submit('save');
  const write = requests.at(-1);
  input('newer');
  submit('close');
  await settle();
  assert.equal(node('#dlg-editor').open, true);
  assert.equal(node('#dlg-prompt').open, false);
  write.respond({ ok: true });
  await settle();
  assert.equal(node('#dlg-prompt').open, true);
  node('#dlg-prompt').close('cancel');
  await settle();
  assert.equal(node('#dlg-editor').open, true);
  assert.equal(node('#editor-text').value, 'newer');
  assert.equal(unsaved().length, 1);
});

test('editor: lưu lỗi giữ nội dung để thử lại', async () => {
  await open();
  input('not lost');
  submit('save');
  requests.at(-1).respond({ error: 'Disk full' }, 500);
  await settle();
  assert.equal(node('#editor-state').textContent, '✖ Lỗi khi lưu');
  assert.equal(node('#editor-text').value, 'not lost');
  assert.equal(node('#editor-save').disabled, false);
  assert.equal(unsaved().length, 1);
  submit('save');
  assert.equal(requests.at(-1).body.content, 'not lost');
  requests.at(-1).respond({ ok: true });
  await settle();
  assert.deepEqual(unsaved(), []);
});

test('editor: kết nối lại giữ nội dung nhưng không ghi sang kết nối mới', async () => {
  const source = await open();
  input('recover me');
  source.connId = 'replacement-connection';
  submit('save');
  assert.equal(requests.length, 1);
  assert.equal(node('#editor-text').value, 'recover me');
  assert.equal(unsaved().length, 1);
  assert.equal(node('#editor-state').textContent, '✖ Kết nối đã đóng');
});

test('editor: đọc từ tab đã đóng không mở editor; đóng editor huỷ yêu cầu đọc cũ', async () => {
  const source = tab();
  const disposedRead = openEditor(source, '/closed.txt');
  source.disposed = true;
  requests.at(-1).respond({ content: 'closed' });
  await disposedRead;
  assert.equal(node('#dlg-editor').open, false);

  const active = await open();
  const nextRead = openEditor(active, '/late.txt');
  const pending = requests.at(-1);
  submit('close');
  await settle();
  pending.respond({ content: 'late' });
  await nextRead;
  assert.equal(node('#dlg-editor').open, false);
});

test('editor: bấm đóng nhiều lần chỉ hỏi bỏ thay đổi một lần', async () => {
  await open();
  input('unsaved');
  submit('close');
  submit('close');
  await settle();
  assert.equal(node('#dlg-prompt').showCount, 1);
  node('#dlg-prompt').close('ok');
  await settle();
  assert.equal(node('#dlg-editor').open, false);
  assert.deepEqual(unsaved(), []);
});
