/* global SearchAddon */
// Tìm trong terminal (Ctrl+F): thanh tìm kiếm nổi góc phải, tô mọi kết quả, Enter/Shift+Enter để nhảy.
import { el } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { prefs } from '../prefs.js';
import { themeOf } from './themes.js';

// Màu tô phải ở dạng #RRGGBB; chọn theo nền terminal để chữ vẫn đọc được trên cả bảng màu sáng lẫn tối.
function decorations() {
  const bg = (themeOf(prefs().theme).theme.background || '#000000').replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(bg.slice(i, i + 2), 16) || 0);
  const light = r * 0.299 + g * 0.587 + b * 0.114 > 150;
  return light
    ? { matchBackground: '#fff0a0', matchOverviewRuler: '#d9a400', activeMatchBackground: '#ffc94d', activeMatchBorder: '#c47f00', activeMatchColorOverviewRuler: '#c47f00' }
    : { matchBackground: '#5b4a12', matchOverviewRuler: '#c9a227', activeMatchBackground: '#9a6a00', activeMatchBorder: '#ffc04d', activeMatchColorOverviewRuler: '#ffc04d' };
}

function toggle(label, title) {
  return el('button', { type: 'button', class: 'ts-toggle', title, 'aria-label': title, 'aria-pressed': 'false', text: label });
}

export function attachSearch(tab) {
  const addon = new SearchAddon.SearchAddon({ highlightLimit: 2000 });
  tab.term.loadAddon(addon);

  const input = el('input', { class: 'ts-input', placeholder: 'Tìm trong terminal', spellcheck: 'false', 'aria-label': 'Tìm trong terminal' });
  const count = el('span', { class: 'ts-count' });
  const opts = { caseSensitive: toggle('Aa', 'Phân biệt hoa thường'), wholeWord: toggle('ab', 'Chỉ khớp nguyên từ'), regex: toggle('.*', 'Biểu thức chính quy (regex)') };
  const btn = (name, title, onclick) => el('button', { type: 'button', class: 'ts-btn', title, 'aria-label': title, onclick }, icon(name));
  const bar = el(
    'div',
    { class: 'term-search', hidden: true, role: 'search', onmousedown: (e) => e.stopPropagation() },
    icon('search', 'ts-icon'),
    input,
    count,
    opts.caseSensitive,
    opts.wholeWord,
    opts.regex,
    el('span', { class: 'ts-sep' }),
    btn('chevron-up', 'Kết quả trước (Shift+Enter)', () => find(false)),
    btn('chevron-down', 'Kết quả sau (Enter)', () => find(true)),
    btn('x', 'Đóng (Esc)', close)
  );
  tab.paneEl.append(bar);

  const options = (incremental) => ({
    caseSensitive: opts.caseSensitive.getAttribute('aria-pressed') === 'true',
    wholeWord: opts.wholeWord.getAttribute('aria-pressed') === 'true',
    regex: opts.regex.getAttribute('aria-pressed') === 'true',
    incremental,
    decorations: decorations(),
  });

  function find(forward, incremental = false) {
    const q = input.value;
    bar.classList.remove('none', 'bad');
    if (!q) {
      addon.clearDecorations();
      count.textContent = '';
      return;
    }
    // Nhảy tới kết quả sẽ bôi đen chữ: không để "bôi đen là copy" ghi đè clipboard.
    tab.suppressCopyUntil = performance.now() + 200;
    try {
      const found = forward ? addon.findNext(q, options(incremental)) : addon.findPrevious(q, options(false));
      if (!found) {
        bar.classList.add('none');
        count.textContent = 'Không có';
      }
    } catch {
      bar.classList.add('bad');
      count.textContent = 'Regex lỗi';
    }
  }

  addon.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (!input.value) return;
    if (!resultCount) {
      bar.classList.add('none');
      count.textContent = 'Không có';
    } else {
      bar.classList.remove('none');
      count.textContent = resultIndex < 0 ? `${resultCount}+` : `${resultIndex + 1}/${resultCount}`;
    }
  });

  input.addEventListener('input', () => find(true, true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      find(!e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  for (const b of Object.values(opts)) {
    b.addEventListener('click', () => {
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
      find(true, true);
      input.focus();
    });
  }

  function open() {
    // Đang bôi đen một đoạn ngắn trên một dòng thì lấy làm từ cần tìm (giống VS Code).
    const sel = tab.term.getSelection();
    if (sel && sel.length <= 200 && !sel.includes('\n')) input.value = sel;
    bar.hidden = false;
    input.focus();
    input.select();
    if (input.value) find(true, true);
  }

  function close() {
    bar.hidden = true;
    addon.clearDecorations();
    count.textContent = '';
    bar.classList.remove('none', 'bad');
    tab.term.focus();
  }

  return { open, close, get isOpen() { return !bar.hidden; } };
}
