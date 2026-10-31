'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// rdp nạp vault: chỉ khởi tạo dữ liệu thử trong thư mục riêng.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-rdp-display-'));
process.env.WEBTERM_DATA = tmp;
const { rdpContent, launch } = require('../../lib/rdp');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const session = { host: 'rdp.example.test', port: 3389, rdpAuth: 'prompt' };
const properties = (content) => new Map(content.trimEnd().split('\r\n').map((line) => {
  const at = line.indexOf(':');
  return [line.slice(0, at), line.slice(at + 1)];
}));

for (const [name, fullscreen, screenMode] of [['session cũ', undefined, 'i:1'], ['cửa sổ', false, 'i:1'], ['toàn màn hình', true, 'i:2']]) {
  test(`RDP display: ${name} co nội dung khi resize, giữ lựa chọn màn hình và DPI của Windows`, () => {
    const props = properties(rdpContent({ ...session, rdpFullscreen: fullscreen }));
    assert.equal(props.get('screen mode id'), screenMode);
    assert.equal(props.get('smart sizing'), 'i:1');
    assert.equal(props.get('dynamic resolution'), 'i:1');
    assert.equal(props.get('use multimon'), 'i:0');
    for (const key of ['desktopwidth', 'desktopheight', 'desktopscalefactor', 'devicescalefactor']) {
      assert.ok(!props.has(key), `để Windows chọn ${key} theo màn hình hiện tại`);
    }
  });
}

test('RDP display: thay đổi cách co giãn giữ nguyên thông tin kết nối và mật khẩu mã hoá', () => {
  const props = properties(rdpContent({ ...session, port: 3390, username: 'DOMAIN\\tester', rdpFullscreen: false }, { blob: 'a1b2' }));
  assert.equal(props.get('full address'), 's:rdp.example.test:3390');
  assert.equal(props.get('username'), 's:DOMAIN\\tester');
  assert.equal(props.get('password 51'), 'b:a1b2');
  assert.equal(props.get('prompt for credentials'), 'i:0');
});

test('RDP display: launch áp dụng co giãn cho session hiện có', { skip: process.platform !== 'win32' }, async () => {
  const saved = process.env.WEBTERM_RDP_DRYRUN;
  process.env.WEBTERM_RDP_DRYRUN = '1';
  try {
    const result = await launch(session);
    assert.equal(result.mode, 'prompt');
    const props = properties(result.rdp);
    assert.equal(props.get('screen mode id'), 'i:1');
    assert.equal(props.get('smart sizing'), 'i:1');
    assert.equal(props.get('dynamic resolution'), 'i:1');
  } finally {
    if (saved === undefined) delete process.env.WEBTERM_RDP_DRYRUN;
    else process.env.WEBTERM_RDP_DRYRUN = saved;
  }
});
