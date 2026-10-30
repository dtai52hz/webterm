// Sao lưu / khôi phục session, macro, tunnel, cài đặt, known hosts ra file JSON.
import { $, toast, saveFile } from './core/dom.js';
import { promptDialog, choiceDialog } from './core/dialogs.js';
import { api } from './core/api.js';
import { bus } from './state.js';

async function exportBackup() {
  const r = await promptDialog({
    title: 'Sao lưu dữ liệu WebTerm',
    message: 'File backup gồm session, macro, tunnel, cài đặt và known hosts. Mật khẩu đã lưu chỉ được đưa vào khi bạn đặt mật khẩu backup (file được mã hoá, mang sang máy khác vẫn dùng được).',
    fields: [
      { name: 'includeSecrets', label: 'Kèm mật khẩu/passphrase đã lưu (mã hoá bằng mật khẩu backup)', type: 'checkbox', value: false },
      { name: 'p1', label: 'Mật khẩu backup (chỉ cần khi kèm mật khẩu)', type: 'password' },
      { name: 'p2', label: 'Nhập lại mật khẩu backup', type: 'password' },
    ],
    okText: 'Tải file backup',
  });
  if (!r) return;
  if (r.includeSecrets && r.p1 !== r.p2) return toast('Hai lần nhập mật khẩu backup không khớp', 'error');
  try {
    const res = await fetch('/api/backup/export', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeSecrets: r.includeSecrets, password: r.p1 }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    saveFile(`webterm-backup-${new Date().toISOString().slice(0, 10)}.json`, await res.blob(), 'application/json');
    toast('Đã tạo file backup', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function importFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast('File không phải JSON hợp lệ', 'error');
  }
  if (!data || data.format !== 'webterm-backup') return toast('Đây không phải file backup của WebTerm', 'error');
  const counts = `${(data.sessions || []).length} session, ${(data.macros || []).length} macro, ${(data.tunnels || []).length} tunnel`;
  const mode = await choiceDialog('Khôi phục từ file backup', `${file.name}: ${counts}${data.secrets ? ', có kèm mật khẩu đã lưu' : ''}.\nGộp: giữ dữ liệu hiện có, bỏ qua mục trùng. Thay thế: xoá session/macro/tunnel hiện có rồi nhập.`, [
    { value: 'merge', label: 'Gộp vào dữ liệu hiện có' },
    { value: 'replace', label: 'Thay thế toàn bộ', danger: true },
    { value: 'cancel', label: 'Huỷ' },
  ]);
  if (!mode) return;
  let password;
  if (data.secrets) {
    const p = await promptDialog({ title: 'Mật khẩu backup', fields: [{ name: 'p', label: 'Mật khẩu đã đặt khi sao lưu', type: 'password' }], okText: 'Khôi phục' });
    if (!p) return;
    password = p.p;
  }
  try {
    const s = await api('POST', '/api/backup/import', { content: data, password, mode });
    toast(`Đã khôi phục: ${s.sessions.added} session, ${s.macros.added} macro, ${s.tunnels.added} tunnel${s.sessions.skipped ? ` (bỏ qua ${s.sessions.skipped} session trùng)` : ''}`, 'ok', 6000);
    if (s.warnings.length) await promptDialog({ title: 'Lưu ý sau khi khôi phục', message: s.warnings.join('\n'), okText: 'Đã hiểu' });
    bus.emit('sessions-reload');
    bus.emit('macros-reload');
  } catch (e) {
    if (e.code === 'locked') bus.emit('vault-locked');
    toast(e.message, 'error', 6000);
  }
}

export function initBackup() {
  const input = $('#backup-file-input');
  input.addEventListener('change', () => {
    const f = input.files[0];
    input.value = '';
    if (f) importFile(f);
  });
  bus.provide('tools-menu', () => [
    { icon: 'save', label: 'Sao lưu dữ liệu…', action: exportBackup },
    { icon: 'restore', label: 'Khôi phục từ file backup…', action: () => input.click() },
  ]);
}
