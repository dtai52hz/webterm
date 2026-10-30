// Tiện ích DOM dùng chung.
import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k === 'vars') for (const [n, val] of Object.entries(v)) node.style.setProperty(n, val);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'value' || k === 'selected') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

const TOAST_ICON = { info: 'info', ok: 'check', error: 'alert' };

export function toast(message, kind = 'info', ms = 3500) {
  const t = el('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, icon(TOAST_ICON[kind] || 'info'), el('span', { text: message }));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Đã copy', 'ok', 1500);
  } catch {
    toast('Trình duyệt chặn clipboard', 'error');
  }
}

// Tải một Blob/chuỗi về máy (backup, private key...).
export function saveFile(name, content, type = 'application/octet-stream') {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
