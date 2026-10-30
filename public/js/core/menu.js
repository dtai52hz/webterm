// Menu chuột phải dùng chung.
import { $, el, toast } from './dom.js';
import { icon } from './icons.js';

const menu = () => $('#ctxmenu');
let trigger = null;

function focusItem(node) {
  menu().querySelectorAll('button').forEach((button) => (button.tabIndex = button === node ? 0 : -1));
  node?.focus({ preventScroll: true });
  node?.scrollIntoView({ block: 'nearest' });
}

// items: [{label, icon, action, danger, disabled, checked}] hoặc '-' để kẻ ngang; giá trị falsy bị bỏ qua.
export function showMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  const m = menu();
  const source = e.currentTarget;
  const nextTrigger = source?.matches?.('button, input, textarea, select, a[href], [tabindex]') ? source : document.activeElement;
  hideMenu({ restoreFocus: false });
  trigger = nextTrigger;
  if (trigger?.getAttribute('aria-haspopup') === 'menu') trigger.setAttribute('aria-expanded', 'true');
  m.replaceChildren(
    ...items
      .filter(Boolean)
      .map((it) =>
        it === '-'
          ? el('hr')
          : el(
              'button',
              {
                class: it.danger ? 'danger' : '',
                type: 'button',
                role: typeof it.checked === 'boolean' ? 'menuitemcheckbox' : 'menuitem',
                ...(typeof it.checked === 'boolean' ? { 'aria-checked': String(it.checked) } : {}),
                tabindex: -1,
                disabled: it.disabled,
                onclick: async () => {
                  hideMenu();
                  try {
                    await it.action();
                  } catch (error) {
                    toast(error.message || 'Không thực hiện được thao tác', 'error');
                  }
                },
              },
              it.icon ? icon(it.icon) : el('span', { class: 'ic' }),
              el('span', { class: 'mi-label', text: it.label }),
              it.checked ? icon('check', 'mi-check') : null
            )
      )
  );
  m.hidden = false;
  const x = Math.min(e.clientX, window.innerWidth - m.offsetWidth - 6);
  const y = Math.min(e.clientY, window.innerHeight - m.offsetHeight - 6);
  m.style.left = `${Math.max(4, x)}px`;
  m.style.top = `${Math.max(4, y)}px`;
  focusItem(m.querySelector('button:not(:disabled)'));
}

// Menu thả xuống gắn với một nút (Terminal, Chia màn hình, Công cụ...).
export function showMenuAt(button, items) {
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-controls', 'ctxmenu');
  const r = button.getBoundingClientRect();
  showMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: button, clientX: r.left, clientY: r.bottom + 4 }, items);
}

export function hideMenu({ restoreFocus = true } = {}) {
  const m = menu();
  if (m.hidden) return;
  const focused = m.contains(document.activeElement);
  m.hidden = true;
  const previous = trigger;
  trigger = null;
  if (previous?.getAttribute('aria-haspopup') === 'menu') previous.setAttribute('aria-expanded', 'false');
  if (restoreFocus && focused && previous?.isConnected) previous.focus({ preventScroll: true });
}

document.addEventListener('mousedown', (e) => !menu().contains(e.target) && hideMenu({ restoreFocus: false }));
document.addEventListener('keydown', (e) => {
  const m = menu();
  if (m.hidden) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    hideMenu();
    return;
  }
  if (!m.contains(e.target)) return;
  if (e.key === 'Tab') return hideMenu();
  const items = [...m.querySelectorAll('button:not(:disabled)')];
  const index = items.indexOf(document.activeElement);
  let next;
  if (e.key === 'ArrowDown') next = items[(index + 1) % items.length];
  else if (e.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
  else if (e.key === 'Home') next = items[0];
  else if (e.key === 'End') next = items[items.length - 1];
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    e.stopPropagation();
    if (index >= 0) items[index].click();
    return;
  }
  if (next) {
    e.preventDefault();
    e.stopPropagation();
    focusItem(next);
  }
});
window.addEventListener('blur', () => hideMenu({ restoreFocus: false }));
window.addEventListener('resize', () => hideMenu());
