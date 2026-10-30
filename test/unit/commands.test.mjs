import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSearch, searchCommands } from '../../public/js/core/command-search.js';

const commands = [
  { id: 'ssh', label: 'Máy chủ Đà Nẵng', detail: 'Khách hàng · deploy@10.0.0.5:2222', keywords: 'production', group: 'Sessions' },
  { id: 'settings', label: 'Mở cài đặt', detail: 'Giao diện và terminal', group: 'Thao tác' },
  { id: 'prod', label: 'Production', detail: 'root@vps', group: 'Sessions' },
];

test('truy cập nhanh: tìm không dấu và kết hợp tên, host, user, ghi chú', () => {
  assert.equal(normalizeSearch('ĐÀ NẴNG'), 'da nang');
  assert.deepEqual(searchCommands(commands, 'da nang deploy 2222 production').map((c) => c.id), ['ssh']);
  assert.deepEqual(searchCommands(commands, 'cai dat').map((c) => c.id), ['settings']);
  assert.deepEqual(searchCommands(commands, 'khong ton tai'), []);
});

test('truy cập nhanh: ưu tiên tên khớp và không làm đổi thứ tự danh sách gốc', () => {
  assert.deepEqual(searchCommands(commands, 'production').map((c) => c.id), ['prod', 'ssh']);
  assert.deepEqual(searchCommands(commands, '  '), commands);
  assert.equal(commands[0].id, 'ssh');
});
