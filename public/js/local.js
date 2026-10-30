// Terminal local (PowerShell, CMD, Git Bash, WSL) và mở Remote Desktop cho session RDP.
import { $, el, toast } from './core/dom.js';
import { api } from './core/api.js';
import { promptDialog } from './core/dialogs.js';
import { showMenuAt } from './core/menu.js';
import { state, bus } from './state.js';
import { TermTab } from './term/tab.js';

export async function loadShells() {
  if (!state.capabilities.localFeatures) return (state.shells = []);
  try {
    state.shells = await api('GET', '/api/shells');
  } catch {
    state.shells = [];
  }
  return state.shells;
}

export function openLocal(shell) {
  const s = shell || (state.shells || [])[0];
  if (!s) return toast('Không tìm thấy shell nào trên máy này', 'error');
  return new TermTab({ kind: 'local', name: s.name, shell: s.id, windowsPty: state.windowsPty });
}

async function launchRdp(s) {
  let password;
  if (!s.hasPassword && (s.rdpAuth || 'dpapi') !== 'prompt') {
    const r = await promptDialog({
      title: `Remote Desktop: ${s.name}`,
      message: `${s.username ? `User: ${s.username}\n` : ''}Nhập mật khẩu để tự đăng nhập, hoặc để trống để Windows tự hỏi.`,
      fields: [{ name: 'password', label: 'Mật khẩu (tuỳ chọn)', type: 'password' }],
      okText: 'Mở Remote Desktop',
    });
    if (!r) return;
    password = r.password || undefined;
  }
  try {
    const res = await api('POST', `/api/rdp/${s.id}/launch`, { password });
    toast(res.mode === 'prompt' ? 'Đang mở Remote Desktop (Windows sẽ hỏi mật khẩu)…' : 'Đang mở Remote Desktop…', 'ok', 3000);
  } catch (e) {
    toast(e.message, 'error');
  }
}

export function initLocal() {
  const menu = (btn) =>
    showMenuAt(btn, [
      ...(state.shells || []).map((s) => ({ icon: 'terminal', label: s.name, action: () => openLocal(s) })),
      (state.shells || []).length ? '-' : null,
      { icon: 'save', label: 'Lưu thành session…', action: () => bus.emit('save-as-session', { type: 'local', name: 'Terminal local', shell: (state.shells[0] || {}).id }) },
    ]);
  $('#btn-local').addEventListener('click', (e) => menu(e.currentTarget));
  $('#home-local').addEventListener('click', () => openLocal());
  bus.on('launch-rdp', launchRdp);
}
