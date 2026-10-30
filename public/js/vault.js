// Master password: màn hình mở khoá khi khởi động, nút 🔒/🔓 trên thanh công cụ, mục Bảo mật trong Cài đặt.
import { $, el, toast } from './core/dom.js';
import { api } from './core/api.js';
import { openModal, promptDialog, confirmDialog } from './core/dialogs.js';
import { showMenuAt } from './core/menu.js';
import { icon } from './core/icons.js';
import { state, bus } from './state.js';

const vs = () => state.capabilities.vault || { enabled: false, locked: false };

function setStatus(st) {
  state.capabilities.vault = st;
  const btn = $('#btn-vault');
  btn.hidden = !st.enabled;
  btn.replaceChildren(icon(st.locked ? 'lock' : 'unlock'));
  btn.title = st.locked ? 'Kho mật khẩu đang khoá: bấm để nhập master password' : 'Master password: đã mở khoá';
  btn.classList.toggle('locked', st.locked);
  renderSettings();
  bus.emit('vault-status', st);
}

let unlocking = null;
export function openUnlock() {
  if (unlocking) return unlocking;
  const dlg = $('#dlg-unlock');
  const f = $('#unlock-form');
  f.reset();
  $('#unlock-error').hidden = true;
  unlocking = openModal(dlg).finally(() => (unlocking = null));
  f.elements.password.focus();
  return unlocking;
}

async function submitUnlock(e) {
  const action = e.submitter ? e.submitter.value : 'unlock';
  if (action === 'skip') return;
  e.preventDefault();
  const f = e.target.elements;
  const err = $('#unlock-error');
  try {
    setStatus(await api('POST', '/api/vault/unlock', { password: f.password.value }));
    $('#dlg-unlock').close('unlocked');
    toast('Đã mở khoá mật khẩu đã lưu', 'ok', 2000);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    f.password.select();
  }
}

export async function enableVault() {
  const r = await promptDialog({
    title: 'Bật master password',
    message:
      'Mật khẩu đã lưu sẽ được khoá bằng master password. Mỗi lần mở WebTerm bạn cần nhập master password để dùng chúng.\nNếu quên master password, các mật khẩu đã lưu sẽ không khôi phục được (session vẫn còn).',
    fields: [
      { name: 'p1', label: 'Master password (ít nhất 6 ký tự)', type: 'password' },
      { name: 'p2', label: 'Nhập lại', type: 'password' },
    ],
    okText: 'Bật',
  });
  if (!r) return;
  if (r.p1 !== r.p2) return toast('Hai lần nhập không khớp', 'error');
  try {
    setStatus(await api('POST', '/api/vault/enable', { password: r.p1 }));
    toast('Đã bật master password', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function change() {
  const r = await promptDialog({
    title: 'Đổi master password',
    fields: [
      { name: 'old', label: 'Master password hiện tại', type: 'password' },
      { name: 'p1', label: 'Master password mới', type: 'password' },
      { name: 'p2', label: 'Nhập lại', type: 'password' },
    ],
    okText: 'Đổi',
  });
  if (!r) return;
  if (r.p1 !== r.p2) return toast('Hai lần nhập không khớp', 'error');
  try {
    setStatus(await api('POST', '/api/vault/change', { oldPassword: r.old, newPassword: r.p1 }));
    toast('Đã đổi master password', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function disable() {
  const r = await promptDialog({
    title: 'Tắt master password',
    message: 'Mật khẩu đã lưu vẫn được mã hoá, nhưng bằng khoá nằm sẵn trên máy (không cần nhập gì khi mở WebTerm).',
    fields: [{ name: 'p', label: 'Master password', type: 'password' }],
    okText: 'Tắt',
    danger: true,
  });
  if (!r) return;
  try {
    setStatus(await api('POST', '/api/vault/disable', { password: r.p }));
    toast('Đã tắt master password', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function lockNow() {
  try {
    setStatus(await api('POST', '/api/vault/lock'));
    toast('Đã khoá mật khẩu đã lưu', 'ok', 2000);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderSettings() {
  const box = $('#vault-settings');
  if (!box) return;
  const st = vs();
  if (!st.enabled) {
    box.replaceChildren(
      el(
        'div',
        { class: 'vault-box' },
        el('div', { class: 'vault-state' }, icon('unlock'), 'Chưa bật master password'),
        el('p', { class: 'muted small', text: 'Mật khẩu đã lưu đang được mã hoá bằng khoá nằm trên máy này. Bật master password để ai mở được máy/thư mục dữ liệu cũng không dùng được mật khẩu nếu không biết master password (giống MobaXterm).' }),
        el('div', {}, el('button', { class: 'btn primary', type: 'button', onclick: enableVault }, icon('shield-check'), 'Bật master password…'))
      )
    );
    return;
  }
  box.replaceChildren(
    el(
      'div',
      { class: 'vault-box' },
      el('div', { class: `vault-state${st.locked ? ' locked' : ''}` }, icon(st.locked ? 'lock' : 'shield-check'), st.locked ? 'Master password đang bật, kho đang khoá' : 'Master password đang bật, đã mở khoá'),
      el(
        'div',
        { class: 'keygen-actions' },
        st.locked
          ? el('button', { class: 'btn primary', type: 'button', onclick: openUnlock }, icon('unlock'), 'Mở khoá…')
          : el('button', { class: 'btn', type: 'button', onclick: lockNow }, icon('lock'), 'Khoá ngay'),
        el('button', { class: 'btn', type: 'button', onclick: change }, icon('key'), 'Đổi master password…'),
        el('button', { class: 'btn danger', type: 'button', onclick: disable }, 'Tắt master password…')
      )
    )
  );
}

export function initVault() {
  $('#unlock-form').addEventListener('submit', submitUnlock);
  $('#btn-vault').addEventListener('click', (e) => {
    if (vs().locked) return openUnlock();
    showMenuAt(e.currentTarget, [
      { icon: 'lock', label: 'Khoá ngay', action: lockNow },
      { icon: 'key', label: 'Đổi master password…', action: change },
      { label: 'Tắt master password…', action: disable, danger: true },
    ]);
  });
  bus.on('capabilities', (caps) => setStatus(caps.vault || { enabled: false, locked: false }));
  bus.on('ready', () => vs().enabled && vs().locked && openUnlock());
  bus.on('sse:vault', (st) => st && setStatus(st));
  bus.on('vault-locked', () => {
    setStatus({ ...vs(), locked: true });
    openUnlock();
  });
  bus.on('settings-form-open', renderSettings);
}
