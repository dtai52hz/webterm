// Hộp thoại modal dùng chung. Mỗi lúc chỉ mở một hộp thoại; các yêu cầu đến cùng lúc
// (vd. 2 tab cùng hỏi mật khẩu) xếp hàng lần lượt.
import { $, el } from './dom.js';

let modalChain = Promise.resolve();
export function queued(fn) {
  const p = modalChain.then(fn);
  modalChain = p.catch(() => {});
  return p;
}

export function openModal(dlg, { signal } = {}) {
  if (signal?.aborted) return Promise.resolve('aborted');
  dlg.returnValue = '';
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      dlg.removeEventListener('close', closed);
      signal?.removeEventListener('abort', aborted);
    };
    const closed = () => {
      const value = dlg.returnValue;
      cleanup();
      resolve(value);
    };
    const aborted = () => {
      if (dlg.open) dlg.close('aborted');
    };
    dlg.addEventListener('close', closed, { once: true });
    signal?.addEventListener('abort', aborted, { once: true });
    try {
      dlg.showModal();
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

// fields: [{name, label, type, value, placeholder, options:[{value,label}]}]
export function promptDialog({ title, message = '', fields = [], okText = 'OK', danger = false, extra = null, signal }) {
  return queued(async () => {
    if (signal?.aborted) return null;
    const dlg = $('#dlg-prompt');
    $('#prompt-title').textContent = title;
    const msg = $('#prompt-message');
    msg.textContent = message;
    msg.hidden = !message;
    const box = $('#prompt-fields');
    box.replaceChildren();
    const inputs = {};
    for (const f of fields) {
      let input;
      if (f.type === 'select') {
        input = el('select', { name: f.name }, ...f.options.map((o) => el('option', { value: o.value, text: o.label, selected: o.value === f.value })));
      } else if (f.type === 'textarea') {
        input = el('textarea', { name: f.name, rows: f.rows || 4, placeholder: f.placeholder || '', spellcheck: 'false', class: 'mono' });
        input.value = f.value ?? '';
      } else {
        input = el('input', {
          type: f.type || 'text',
          name: f.name,
          placeholder: f.placeholder || '',
          spellcheck: 'false',
          autocomplete: f.type === 'password' ? 'current-password' : 'off',
        });
      }
      if (f.type === 'checkbox') {
        input.checked = Boolean(f.value);
        box.append(el('label', { class: 'check' }, input, f.label));
      } else {
        if (f.type !== 'select' && f.type !== 'textarea') input.value = f.value ?? '';
        box.append(el('label', {}, f.label, input));
      }
      inputs[f.name] = input;
    }
    if (extra) box.append(extra);
    const ok = $('#prompt-ok');
    ok.textContent = okText;
    ok.className = `btn ${danger ? 'danger' : 'primary'}`;
    const done = openModal(dlg, { signal });
    const first = box.querySelector('input:not([type=checkbox]), textarea');
    if (first) {
      first.focus();
      if (first.select) first.select();
    } else ok.focus();
    if ((await done) !== 'ok') return null;
    const out = {};
    for (const [k, i] of Object.entries(inputs)) out[k] = i.type === 'checkbox' ? i.checked : i.value;
    return out;
  });
}

export const confirmDialog = (title, message, okText = 'OK', danger = false) =>
  promptDialog({ title, message, okText, danger }).then((r) => r !== null);

// Hỏi chọn một trong nhiều phương án; trả về value hoặc null khi huỷ.
export function choiceDialog(title, message, choices) {
  return queued(async () => {
    const dlg = $('#dlg-choice');
    $('#choice-title').textContent = title;
    $('#choice-message').textContent = message;
    const box = $('#choice-buttons');
    box.replaceChildren(
      ...choices.map((c, i) =>
        el('button', { class: `btn ${c.value === 'cancel' ? 'ghost' : c.danger ? 'danger' : i === 0 ? 'primary' : ''}`, value: c.value, text: c.label })
      )
    );
    const r = await openModal(dlg);
    return r && r !== 'cancel' ? r : null;
  });
}

export function hostKeyDialog(msg, { signal } = {}) {
  return queued(async () => {
    if (signal?.aborted) return false;
    const changed = msg.status === 'changed';
    const hop = msg.hop ? ` (qua ${msg.hop})` : '';
    $('#hostkey-title').textContent = changed ? '⚠ Host key của server đã THAY ĐỔI' : 'Server mới: xác nhận host key';
    $('#hostkey-body').replaceChildren(
      el(
        'div',
        {},
        changed &&
          el('div', {
            class: 'alert',
            text: 'Khoá của server khác với lần kết nối trước. Có thể server vừa được cài lại, hoặc có kẻ đang nghe lén kết nối (man-in-the-middle). Chỉ chấp nhận khi bạn chắc chắn.',
          }),
        el('p', {}, 'Server ', el('b', { text: `${msg.host}:${msg.port}` }), `${hop} · ${msg.keyType}`),
        el('div', { class: 'fingerprint', text: msg.fingerprint }),
        changed
          ? el('p', { class: 'muted small', text: `Fingerprint cũ: ${msg.previous}` })
          : el('p', { class: 'muted small', text: 'Đây là lần đầu kết nối tới server này. Nếu có thể, đối chiếu fingerprint với nhà cung cấp VPS.' })
      )
    );
    $('#hostkey-accept').className = `btn ${changed ? 'danger' : 'primary'}`;
    return (await openModal($('#dlg-hostkey'), { signal })) === 'accept';
  });
}
