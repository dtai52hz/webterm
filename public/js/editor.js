// Trình soạn thảo file trên server (giống MobaTextEditor).
import { $, toast } from './core/dom.js';
import { api } from './core/api.js';
import { openModal, confirmDialog } from './core/dialogs.js';
import { bus } from './state.js';

let editor = null;
let openRequest = 0;
const text = () => $('#editor-text');

export async function openEditor(tab, path, onDownload) {
  const request = ++openRequest;
  const connId = tab.connId;
  const currentRequest = () => request === openRequest && !tab.disposed && tab.connId === connId;
  if (editor && editor.connId === connId && editor.path === path) {
    text().focus();
    return;
  }
  let r;
  try {
    r = await api('POST', `/api/sftp/${connId}/read`, { path });
  } catch (e) {
    if (!currentRequest()) return;
    if (e.status === 413 || e.status === 415) {
      if (await confirmDialog('Không mở được trong trình soạn thảo', `${e.message}. Tải file về máy?`, 'Tải về') && currentRequest()) onDownload && onDownload(path);
    } else toast(e.message, 'error');
    return;
  }
  if (!currentRequest()) return;
  const previous = editor;
  // Một file khác không được thay nội dung khi bản đang mở còn chờ lưu/xác nhận.
  if (previous?.saving) await previous.saving;
  if (!currentRequest() || editor !== previous) return;
  if (!(await allowDiscard(previous))) return;
  if (!currentRequest() || editor !== previous) return;
  // textarea luôn chuẩn hoá xuống dòng thành \n; ghi nhớ CRLF để lưu lại đúng định dạng.
  editor = { tab, connId, path, crlf: r.content.includes('\r\n'), original: r.content.replace(/\r\n/g, '\n'), saving: null };
  $('#editor-title').textContent = path;
  text().value = editor.original;
  updateState();
  if (!$('#dlg-editor').open) openModal($('#dlg-editor'));
  text().focus();
  text().setSelectionRange(0, 0);
  text().scrollTop = 0;
}

const dirty = () => editor && text().value !== editor.original;

function updateState(msg) {
  $('#editor-state').textContent = editor?.saving ? 'Đang lưu…' : msg || (dirty() ? '● Chưa lưu' : editor && editor.crlf ? 'CRLF' : '');
  $('#editor-save').disabled = !editor || Boolean(editor.saving);
}

function save() {
  if (!editor) return;
  const current = editor;
  if (current.saving) return current.saving;
  if (current.tab.connId !== current.connId || current.tab.disposed) {
    updateState('✖ Kết nối đã đóng');
    toast('Kết nối của file đã đóng. Hãy sao chép nội dung trước khi mở lại file từ kết nối mới.', 'error');
    return;
  }
  // Lưu đúng bản đã gửi; nội dung gõ tiếp trong lúc chờ vẫn phải là chưa lưu.
  const snapshot = text().value;
  const content = current.crlf ? snapshot.replace(/\n/g, '\r\n') : snapshot;
  current.saving = (async () => {
    let message;
    try {
      await api('POST', `/api/sftp/${current.connId}/write`, { path: current.path, content });
      current.original = snapshot;
      if (editor === current && !dirty()) message = '✓ Đã lưu';
      if (current.tab.connId === current.connId && !current.tab.disposed) bus.emit('sftp-refresh', current.tab);
    } catch (e) {
      message = '✖ Lỗi khi lưu';
      if (editor === current) toast(e.message, 'error');
    } finally {
      current.saving = null;
      if (editor === current) updateState(message);
    }
  })();
  updateState();
  return current.saving;
}

async function allowDiscard(current) {
  if (!current || !dirty()) return true;
  // Escape hay bấm Đóng nhiều lần chỉ mở một hộp xác nhận.
  if (!current.discardPrompt) {
    current.discardPrompt = confirmDialog('Bỏ thay đổi?', 'File có thay đổi chưa lưu. Đóng mà không lưu?', 'Bỏ thay đổi', true)
      .finally(() => { current.discardPrompt = null; });
  }
  return current.discardPrompt;
}

function close() {
  const current = editor;
  if (!current) return;
  if (current.closing) return current.closing;
  const request = ++openRequest;
  current.closing = (async () => {
    if (current.saving) await current.saving;
    if (editor !== current || request !== openRequest) return;
    if (!(await allowDiscard(current))) return;
    if (editor !== current || request !== openRequest) return;
    $('#dlg-editor').close('closed');
    editor = null;
    updateState();
  })().finally(() => { current.closing = null; });
  return current.closing;
}

export function initEditor() {
  bus.provide('unsaved-changes', () => editor && (dirty() || editor.saving) ? [{ kind: 'editor', path: editor.path }] : []);
  text().addEventListener('input', () => updateState());
  text().addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    } else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      text().setRangeText('\t', text().selectionStart, text().selectionEnd, 'end');
      updateState();
    }
  });
  $('#editor-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.submitter && e.submitter.value === 'close') close();
    else save();
  });
  $('#dlg-editor').addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
}
