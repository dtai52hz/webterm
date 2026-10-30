// Import session từ MobaXterm.ini.
import { $, el, toast } from './core/dom.js';
import { api } from './core/api.js';
import { openModal } from './core/dialogs.js';
import { targetLabel } from './core/format.js';
import { bus } from './state.js';

let importContent = '';

function render(data) {
  const found = data.sessions || [];
  $('#import-source').textContent = `Nguồn: ${data.source} · tìm thấy ${found.length} session SSH`;
  $('#import-list').replaceChildren(
    ...(found.length
      ? found.map((s) =>
          el(
            'div',
            { class: 'import-row' },
            el('div', {}, el('div', { text: s.name }), el('div', { class: 'sub', text: `${targetLabel(s.username, s.host, s.port)}${s.privateKeyPath ? ' · key' : ''}` })),
            el('div', { class: 'muted small', text: s.folder || '(gốc)' })
          )
        )
      : [el('div', { class: 'empty', text: 'Không có session SSH nào.' })])
  );
  const ok = $('#import-ok');
  ok.disabled = !found.length;
  ok.textContent = found.length ? `Import ${found.length} session` : 'Import';
}

export async function openImport() {
  importContent = '';
  $('#import-text').value = '';
  render({ source: 'đang tìm…', sessions: [] });
  const done = openModal($('#dlg-import'));
  try {
    render(await api('POST', '/api/import/mobaxterm', { preview: true }));
  } catch (e) {
    $('#import-source').textContent = `${e.message}. Bạn có thể dán nội dung file ở bên dưới.`;
    $('#import-form details').open = true;
  }
  if ((await done) !== 'import') return;
  try {
    const r = await api('POST', '/api/import/mobaxterm', importContent ? { content: importContent } : {});
    toast(`Đã thêm ${r.added} session${r.skipped ? `, bỏ qua ${r.skipped} trùng` : ''}${r.errors.length ? `, ${r.errors.length} lỗi` : ''}`, 'ok', 5000);
    if (r.errors.length) console.warn('Import errors:', r.errors);
    bus.emit('side', 'sessions');
    bus.emit('sessions-reload');
  } catch (e) {
    toast(e.message, 'error');
  }
}

export function initImport() {
  $('#import-parse').addEventListener('click', async () => {
    const text = $('#import-text').value;
    if (!text.trim()) return;
    try {
      const data = await api('POST', '/api/import/mobaxterm', { preview: true, content: text });
      importContent = text;
      render(data);
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  bus.on('open-import', openImport);
}
