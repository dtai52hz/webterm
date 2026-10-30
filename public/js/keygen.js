// Tạo SSH key (giống MobaKeyGen), chép public key lên server, gán key cho session.
import { $, el, toast, copyText, saveFile } from './core/dom.js';
import { api } from './core/api.js';
import { openModal, promptDialog } from './core/dialogs.js';
import { state, tabs, bus } from './state.js';

let result = null; // { privateKey, publicKey, fingerprint, saved, passphrase, name }

function reset() {
  const f = $('#keygen-form');
  f.reset();
  f.elements.comment.value = `webterm@${new Date().toISOString().slice(0, 10)}`;
  $('#keygen-result').hidden = true;
  $('#keygen-inputs').hidden = false;
  $('#keygen-generate').hidden = false;
  result = null;
}

export function openKeygen() {
  reset();
  openModal($('#dlg-keygen'));
  $('#keygen-form').elements.name.focus();
}

async function generate() {
  const f = $('#keygen-form').elements;
  if (f.passphrase.value !== f.passphrase2.value) return toast('Hai lần nhập passphrase không khớp', 'error');
  const btn = $('#keygen-generate');
  btn.disabled = true;
  btn.textContent = 'Đang tạo…';
  try {
    const r = await api('POST', '/api/keygen', {
      type: f.type.value,
      comment: f.comment.value,
      passphrase: f.passphrase.value,
      name: f.name.value.trim(),
      save: Boolean(state.capabilities.localFeatures),
    });
    result = { ...r, passphrase: f.passphrase.value, name: f.name.value.trim() };
    $('#keygen-public').value = r.publicKey;
    $('#keygen-fingerprint').textContent = `${r.type.toUpperCase()} · ${r.fingerprint}`;
    $('#keygen-saved').textContent = r.saved
      ? `Đã lưu private key: ${r.saved.privatePath}\nPublic key: ${r.saved.publicPath}`
      : 'Chưa lưu trên máy: bấm "Tải private key" để giữ lại.';
    $('#keygen-result').hidden = false;
    $('#keygen-inputs').hidden = true;
    btn.hidden = true;
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Tạo key';
  }
}

async function installOnServer() {
  const connected = [...tabs.values()].filter((t) => t.status === 'connected' && t.target.kind === 'ssh');
  if (!connected.length) return toast('Hãy mở (kết nối) tab SSH tới server cần cài key trước', 'error');
  const r = await promptDialog({
    title: 'Chép public key lên server',
    message: 'Key sẽ được thêm vào ~/.ssh/authorized_keys của user đang đăng nhập (giống ssh-copy-id).',
    fields: [{ name: 'tab', label: 'Server', type: 'select', value: connected[0].key, options: connected.map((t) => ({ value: t.key, label: `${t.labelEl.textContent} — ${t.label}` })) }],
    okText: 'Chép key',
  });
  if (!r) return;
  const tab = tabs.get(r.tab);
  try {
    const res = await api('POST', `/api/sftp/${tab.connId}/install-key`, { publicKey: result.publicKey });
    toast(res.status === 'exists' ? 'Server đã có key này rồi' : `Đã cài key lên ${tab.label}`, 'ok', 4000);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function useForSession() {
  if (!result.saved) return toast('Key chưa được lưu trên máy nên không gán cho session được', 'error');
  const ssh = state.sessions.filter((s) => (s.type || 'ssh') === 'ssh');
  if (!ssh.length) return toast('Chưa có session SSH nào', 'error');
  const r = await promptDialog({
    title: 'Dùng key này cho session',
    message: 'Session sẽ chuyển sang đăng nhập bằng private key vừa tạo.',
    fields: [{ name: 'id', label: 'Session', type: 'select', value: ssh[0].id, options: ssh.map((s) => ({ value: s.id, label: `${s.name} — ${s.username ? s.username + '@' : ''}${s.host}` })) }],
    okText: 'Áp dụng',
  });
  if (!r) return;
  try {
    await api('PUT', `/api/sessions/${r.id}`, { auth: 'key', privateKeyPath: result.saved.sessionPath || result.saved.privatePath, passphrase: result.passphrase || '' });
    toast('Đã cập nhật session', 'ok');
    bus.emit('sessions-reload');
  } catch (e) {
    toast(e.message, 'error');
  }
}

export function initKeygen() {
  $('#keygen-form').addEventListener('submit', (e) => {
    const action = e.submitter ? e.submitter.value : 'generate';
    if (action === 'close') return;
    e.preventDefault();
    generate();
  });
  $('#keygen-copy').addEventListener('click', () => copyText(result.publicKey));
  $('#keygen-install').addEventListener('click', installOnServer);
  $('#keygen-use').addEventListener('click', useForSession);
  $('#keygen-download').addEventListener('click', () => saveFile(result.name || 'id_webterm', result.privateKey, 'text/plain'));
  bus.provide('tools-menu', () => [{ icon: 'key', label: 'Tạo SSH key…', action: openKeygen }]);
}
