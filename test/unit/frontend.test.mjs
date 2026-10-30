// Unit test cho các module giao diện thuần (không cần trình duyệt). Chạy: node --test test/unit
import test from 'node:test';
import assert from 'node:assert';
import { findMatches } from '../../public/js/term/highlight-core.js';
import { escapeKeys, unescapeKeys } from '../../public/js/keys.js';
import { THEMES } from '../../public/js/term/themes.js';

const kinds = (text) => findMatches(text).map((m) => `${text.slice(m.start, m.end)}:${m.kind}`);

test('tô màu: nhận đúng từ khoá theo nhóm, không phân biệt hoa thường', () => {
  assert.deepStrictEqual(kinds('ERROR: connection refused'), ['ERROR:error', 'connection refused:error']);
  assert.deepStrictEqual(kinds('warning: disk almost full'), ['warning:warn']);
  assert.deepStrictEqual(kinds('success: backup completed (OK)'), ['success:ok', 'completed:ok', 'OK:ok']);
});

test('tô màu: chỉ khớp nguyên từ', () => {
  assert.deepStrictEqual(kinds('nginx is inactive'), ['inactive:error'], '"inactive" không bị tô thành "active"');
  assert.deepStrictEqual(kinds('BROKEN tokens, errorlog, okay, passwords'), []);
  assert.deepStrictEqual(kinds('my_error_handler'), []);
});

test('tô màu: địa chỉ IPv4 (kèm cổng) và bỏ qua số phiên bản dài', () => {
  assert.deepStrictEqual(kinds('listening on 10.0.0.5:8080'), ['listening:ok', '10.0.0.5:8080:info']);
  assert.deepStrictEqual(kinds('version 1.2.3.4.5'), []);
  assert.deepStrictEqual(kinds('ip 256.1.1.1'), []);
});

test('tô màu: vị trí đúng với chữ tiếng Việt và emoji', () => {
  const text = 'Lỗi 🙂 error ở đây';
  const [m] = findMatches(text);
  assert.strictEqual(text.slice(m.start, m.end), 'error');
});

test('macro: mã hoá/giải mã phím đặc biệt hai chiều', () => {
  const raw = 'ls -la\r\x1b[A\t\x03\\x';
  const shown = escapeKeys(raw);
  assert.strictEqual(shown, 'ls -la\\r\\e[A\\t\\x03\\\\x');
  assert.strictEqual(unescapeKeys(shown), raw);
});

test('theme: mọi bảng màu đều đủ màu tô từ khoá dạng #RRGGBB', () => {
  for (const [id, th] of Object.entries(THEMES)) {
    for (const k of ['error', 'warn', 'ok', 'info']) assert.match(th.hl[k], /^#[0-9a-f]{6}$/i, `${id}.${k}`);
    assert.ok(th.theme.background && th.theme.foreground, id);
  }
});
