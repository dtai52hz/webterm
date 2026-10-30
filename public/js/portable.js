// Chạy từ USB: nhãn "USB" trên thanh trên cùng và lời nhắc ở trang chủ (dữ liệu nằm đâu, nên bật master password).
import { $, el } from './core/dom.js';
import { icon } from './core/icons.js';
import { enableVault } from './vault.js';
import { state, bus } from './state.js';

function render() {
  const p = state.capabilities.portable;
  const note = $('#portable-note');
  $('#portable-badge').hidden = !p;
  note.hidden = !p;
  if (!p) return;
  $('#portable-badge').title = `Đang chạy từ USB. Dữ liệu lưu trong ${p.dir}`;
  const needVault = !(state.capabilities.vault || {}).enabled;
  note.replaceChildren(
    el('span', { class: 'notice-icon' }, icon('usb')),
    el(
      'div',
      { class: 'notice-body' },
      el('b', { text: 'Đang chạy từ USB' }),
      el('p', { text: `Session, mật khẩu đã lưu, cài đặt và SSH key nằm trong ${p.dir}. Rút USB là mang theo hết, máy này gần như không giữ lại gì.` }),
      needVault && el('p', { class: 'notice-warn', text: 'Chưa bật master password: ai cầm USB cũng dùng được mật khẩu đã lưu.' })
    ),
    needVault && el('button', { class: 'btn primary', type: 'button', onclick: enableVault }, icon('shield-check'), 'Bật master password')
  );
}

export function initPortable() {
  bus.on('capabilities', render);
  bus.on('vault-status', render);
}
