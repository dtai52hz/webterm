import test from 'node:test';
import assert from 'node:assert/strict';
import { openModal, queued } from '../../public/js/core/dialogs.js';

// close() đóng dialog ngay nhưng sự kiện close chạy ở task sau trong trình duyệt.
class Dialog extends EventTarget {
  open = false;
  returnValue = 'old-value';
  showCount = 0;
  closeCount = 0;
  pendingClose = false;
  showModal() {
    assert.equal(this.open, false);
    this.open = true;
    this.showCount++;
  }
  close(value) {
    if (!this.open) return;
    this.open = false;
    if (value !== undefined) this.returnValue = value;
    this.closeCount++;
    this.pendingClose = true;
  }
  dispatchClose() {
    assert.equal(this.pendingClose, true);
    this.pendingClose = false;
    this.dispatchEvent(new Event('close'));
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('modal: signal đã huỷ không mở dialog hay thay đổi giá trị cũ', async () => {
  const dlg = new Dialog();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await openModal(dlg, { signal: controller.signal }), 'aborted');
  assert.equal(dlg.showCount, 0);
  assert.equal(dlg.returnValue, 'old-value');
});

test('modal: huỷ chờ sự kiện close trước khi mở dialog kế tiếp trong hàng đợi', async () => {
  const dlg = new Dialog();
  const controller = new AbortController();
  let firstSettled = false;
  const first = queued(() => openModal(dlg, { signal: controller.signal }));
  first.then(() => { firstSettled = true; });
  const next = queued(() => openModal(dlg));
  await settle();
  assert.equal(dlg.showCount, 1);
  assert.equal(dlg.returnValue, '');

  controller.abort();
  await settle();
  assert.equal(dlg.open, false);
  assert.equal(firstSettled, false);
  assert.equal(dlg.showCount, 1, 'chưa tái sử dụng dialog khi sự kiện close cũ chưa chạy');

  dlg.dispatchClose();
  assert.equal(await first, 'aborted');
  await settle();
  assert.equal(dlg.open, true);
  assert.equal(dlg.showCount, 2);
  assert.equal(dlg.returnValue, '');
  dlg.close('ok');
  dlg.dispatchClose();
  assert.equal(await next, 'ok');
});

test('modal: signal cũ không đóng lần mở dialog tiếp theo', async () => {
  const dlg = new Dialog();
  const controller = new AbortController();
  const first = openModal(dlg, { signal: controller.signal });
  dlg.close('ok');
  dlg.dispatchClose();
  assert.equal(await first, 'ok');

  const next = openModal(dlg);
  controller.abort();
  assert.equal(dlg.open, true);
  assert.equal(dlg.closeCount, 1);
  dlg.close();
  dlg.dispatchClose();
  assert.equal(await next, '', 'không dùng lại returnValue từ lần trước');
});

test('modal: lỗi showModal không chặn các yêu cầu xếp hàng sau', async () => {
  const broken = new Dialog();
  const expected = new Error('showModal failed');
  broken.showModal = () => { throw expected; };
  await assert.rejects(queued(() => openModal(broken)), (e) => e === expected);
  const dlg = new Dialog();
  const next = queued(() => openModal(dlg));
  await settle();
  assert.equal(dlg.open, true);
  dlg.close('ok');
  dlg.dispatchClose();
  assert.equal(await next, 'ok');
});
