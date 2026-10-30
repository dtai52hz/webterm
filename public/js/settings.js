// Hộp thoại Cài đặt: bảng màu, font, con trỏ, copy/dán, tô màu từ khoá, editor ngoài, bảo mật.
import { $, $$, el, toast } from './core/dom.js';
import { api } from './core/api.js';
import { openModal } from './core/dialogs.js';
import { storage } from './core/storage.js';
import { icon } from './core/icons.js';
import { state, bus } from './state.js';
import { prefs } from './prefs.js';
import { THEMES, themeOf } from './term/themes.js';
import { findMatches } from './term/highlight-core.js';

const form = () => $('#settings-form');
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

// Giao diện ứng dụng: "Theo Windows" đi theo chế độ sáng/tối của hệ điều hành.
export function resolvedUiTheme() {
  const pref = prefs().uiTheme || 'system';
  return pref === 'system' ? (systemDark.matches ? 'dark' : 'light') : pref;
}

function applyGlobal() {
  const t = themeOf(prefs().theme).theme;
  const root = document.documentElement;
  root.style.setProperty('--term-bg', t.background);
  root.style.setProperty('--term-fg', t.foreground);
  const ui = resolvedUiTheme();
  root.dataset.theme = ui;
  storage.set('wt.uiTheme', prefs().uiTheme || 'system');
  const btn = $('#btn-theme');
  if (btn) {
    btn.replaceChildren(icon(ui === 'dark' ? 'sun' : 'moon'));
    btn.title = ui === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối';
  }
}

// Nút mặt trời/mặt trăng trên thanh trên cùng: chuyển nhanh giữa sáng và tối.
export function toggleUiTheme() {
  return save({ uiTheme: resolvedUiTheme() === 'dark' ? 'light' : 'dark' });
}

export async function loadSettings() {
  try {
    state.settings = await api('GET', '/api/settings');
  } catch {
    state.settings = null;
  }
  applyGlobal();
  bus.emit('settings-changed', prefs());
}

async function save(patch) {
  try {
    state.settings = await api('PUT', '/api/settings', patch);
    applyGlobal();
    bus.emit('settings-changed', prefs());
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

// Xem trước bảng màu: vài dòng terminal mẫu với màu ANSI và từ khoá được tô.
function renderPreview(themeName, highlight) {
  const th = themeOf(themeName);
  const t = th.theme;
  const box = $('#theme-preview');
  box.style.background = t.background;
  box.style.color = t.foreground;
  box.style.fontFamily = form().elements.fontFamily.value || prefs().fontFamily;
  const span = (text, color, bold) => el('span', { text, style: { color, fontWeight: bold ? '700' : '' } });
  const withHl = (text) => {
    if (!highlight) return [text];
    const parts = [];
    let pos = 0;
    for (const m of findMatches(text)) {
      parts.push(text.slice(pos, m.start), span(text.slice(m.start, m.end), th.hl[m.kind]));
      pos = m.end;
    }
    parts.push(text.slice(pos));
    return parts;
  };
  box.replaceChildren(
    el('div', {}, span('root@vps', t.green, true), ':', span('~', t.blue, true), '$ ls'),
    el('div', {}, span('backup', t.blue, true), '  ', span('deploy.sh', t.green, true), '  notes.txt  ', span('www', t.blue, true)),
    el('div', {}, ...withHl('nginx.service - active (running), listening on 10.0.0.5:80')),
    el('div', {}, ...withHl('ERROR: connection refused · warning: disk 91% · backup done OK')),
    el('div', {}, span('root@vps', t.green, true), ':', span('~', t.blue, true), '$ ', el('span', { text: ' ', style: { background: t.cursor } }))
  );
}

function fillForm() {
  const p = prefs();
  const f = form();
  f.elements.theme.replaceChildren(...Object.entries(THEMES).map(([id, th]) => el('option', { value: id, text: th.label, selected: id === p.theme })));
  f.elements.uiTheme.value = p.uiTheme || 'system';
  for (const k of ['fontFamily', 'fontSize', 'cursorStyle', 'scrollback']) f.elements[k].value = p[k];
  for (const k of ['cursorBlink', 'copyOnSelect', 'rightClickPaste', 'highlight']) f.elements[k].checked = Boolean(p[k]);
  renderPreview(p.theme, p.highlight);
  bus.emit('settings-form-open', { form: f, prefs: p });
}

function showTab(name) {
  $$('.settings-tabs button', form()).forEach((b) => b.classList.toggle('active', b.dataset.stab === name));
  $$('[data-spanel]', form()).forEach((s) => (s.hidden = s.dataset.spanel !== name));
}

export function openSettings(tab = 'terminal') {
  fillForm();
  showTab(tab);
  openModal($('#dlg-settings'));
}

export function initSettings() {
  const f = form();
  $('#btn-settings').addEventListener('click', () => openSettings());
  $$('.settings-tabs button', f).forEach((b) => b.addEventListener('click', () => showTab(b.dataset.stab)));
  f.elements.theme.addEventListener('change', () => renderPreview(f.elements.theme.value, f.elements.highlight.checked));
  f.elements.highlight.addEventListener('change', () => renderPreview(f.elements.theme.value, f.elements.highlight.checked));
  f.elements.fontFamily.addEventListener('change', () => renderPreview(f.elements.theme.value, f.elements.highlight.checked));
  f.addEventListener('submit', async (e) => {
    const action = e.submitter ? e.submitter.value : 'save';
    if (action === 'cancel') return;
    e.preventDefault();
    const patch = {
      uiTheme: f.elements.uiTheme.value || 'system',
      theme: f.elements.theme.value,
      fontFamily: f.elements.fontFamily.value,
      fontSize: Number(f.elements.fontSize.value),
      cursorStyle: f.elements.cursorStyle.value,
      scrollback: Number(f.elements.scrollback.value),
      cursorBlink: f.elements.cursorBlink.checked,
      copyOnSelect: f.elements.copyOnSelect.checked,
      rightClickPaste: f.elements.rightClickPaste.checked,
      highlight: f.elements.highlight.checked,
      ...Object.assign({}, ...bus.collect('settings-patch', f)),
    };
    if (await save(patch)) {
      $('#dlg-settings').close('saved');
      toast('Đã lưu cài đặt', 'ok', 1800);
    }
  });

  $('#btn-theme').addEventListener('click', toggleUiTheme);
  // Windows đổi chế độ sáng/tối: áp dụng ngay nếu đang chọn "Theo Windows".
  systemDark.addEventListener('change', () => (prefs().uiTheme || 'system') === 'system' && applyGlobal());

  // Ctrl + lăn chuột trong terminal: đổi cỡ chữ ngay, lưu sau một nhịp.
  let saveTimer = null;
  bus.on('font-step', (delta) => {
    const size = Math.max(9, Math.min(28, prefs().fontSize + delta));
    state.settings = { ...prefs(), fontSize: size };
    bus.emit('settings-changed', prefs());
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save({ fontSize: size }), 600);
  });

  // Tab Công cụ: chọn editor ngoài (tự dò Notepad++, VS Code, Sublime, Notepad) hoặc nhập đường dẫn .exe.
  bus.on('settings-form-open', async ({ form: fm, prefs: p }) => {
    const sel = fm.elements.externalEditor;
    fm.elements.externalEditorPath.value = '';
    if (!state.capabilities.localFeatures) {
      sel.replaceChildren(el('option', { value: '', text: 'Chỉ dùng được trên chính máy chạy WebTerm' }));
      sel.disabled = true;
      return;
    }
    let info = { detected: [] };
    try {
      info = await api('GET', '/api/editors');
    } catch {}
    const known = info.detected.map((d) => d.path);
    sel.disabled = false;
    sel.replaceChildren(
      el('option', { value: '', text: `Tự động${info.detected[0] ? ` (${info.detected[0].name})` : ''}` }),
      ...info.detected.map((d) => el('option', { value: d.path, text: d.name })),
      el('option', { value: '__custom', text: 'File .exe khác…' })
    );
    if (p.externalEditor && !known.includes(p.externalEditor)) {
      sel.value = '__custom';
      fm.elements.externalEditorPath.value = p.externalEditor;
    } else sel.value = p.externalEditor || '';
  });
  bus.provide('settings-patch', (fm) => {
    if (!state.capabilities.localFeatures) return [];
    const v = fm.elements.externalEditor.value;
    return [{ externalEditor: v === '__custom' ? fm.elements.externalEditorPath.value.trim() : v }];
  });

  // Cửa sổ khác đổi cài đặt: áp dụng luôn ở đây.
  bus.on('sse:settings', (data) => {
    if (!data) return;
    state.settings = data;
    applyGlobal();
    bus.emit('settings-changed', prefs());
  });
}
