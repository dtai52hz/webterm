// Chia màn hình: 1 / 2 cột / 2 hàng / 4 ô, mỗi ô hiện một tab terminal (giống chế độ Split của MobaXterm).
import { $, $$, el } from './core/dom.js';
import { showMenuAt } from './core/menu.js';
import { storage } from './core/storage.js';
import { icon } from './core/icons.js';
import { state, tabs, bus } from './state.js';
import { activate } from './term/tab.js';

const MODES = {
  1: { label: 'Một màn hình', icon: 'square', slots: 1 },
  '2v': { label: 'Chia 2 cột', icon: 'split', slots: 2 },
  '2h': { label: 'Chia 2 hàng', icon: 'rows', slots: 2 },
  4: { label: 'Chia 4 ô', icon: 'grid', slots: 4 },
};

let mode = storage.get('wt.layout', '1');
if (!MODES[mode]) mode = '1';
let slots = [];
let focus = 0;
const mru = []; // tab dùng gần đây nhất ở đầu

const splitActive = () => mode !== '1' && !state.multiExec && state.activeKey !== 'home' && tabs.size > 0;

function touchMru(key) {
  const i = mru.indexOf(key);
  if (i >= 0) mru.splice(i, 1);
  mru.unshift(key);
}

function fillSlots() {
  const n = MODES[mode].slots;
  slots = slots.filter((k) => tabs.has(k)).slice(0, n);
  for (const k of mru) {
    if (slots.length >= n) break;
    if (tabs.has(k) && !slots.includes(k)) slots.push(k);
  }
  for (const k of tabs.keys()) {
    if (slots.length >= n) break;
    if (!slots.includes(k)) slots.push(k);
  }
  if (focus >= n) focus = 0;
}

function render() {
  const on = splitActive();
  document.body.classList.toggle('split', on);
  for (const m of Object.keys(MODES)) document.body.classList.toggle(`layout-${m}`, on && mode === m);
  $$('#panes .term-pane').forEach((p) => {
    const idx = on ? slots.indexOf(p.dataset.tab) : -1;
    p.classList.toggle('slotted', idx >= 0);
    p.style.gridArea = idx >= 0 ? `s${idx}` : '';
  });
  // Ô chưa có tab: hiện gợi ý thay vì để trống.
  $$('#panes .slot-empty').forEach((n) => n.remove());
  if (on) {
    for (let i = slots.length; i < MODES[mode].slots; i++) {
      $('#panes').append(el('div', { class: 'slot-empty', style: { gridArea: `s${i}` } }, icon('plus'), 'Mở thêm session hoặc terminal để hiện ở ô này'));
    }
  }
  const btn = $('#btn-layout');
  btn.classList.toggle('on', mode !== '1');
  btn.querySelector('.ic').replaceWith(icon(MODES[mode].icon === 'square' ? 'split' : MODES[mode].icon));
  requestAnimationFrame(() => tabs.forEach((t) => t.scheduleFit()));
}

export function setLayout(next) {
  mode = MODES[next] ? next : '1';
  storage.set('wt.layout', mode);
  fillSlots();
  if (state.activeKey !== 'home') focus = Math.max(0, slots.indexOf(state.activeKey));
  render();
}

export function initLayout() {
  $('#btn-layout').addEventListener('click', (e) =>
    showMenuAt(
      e.currentTarget,
      Object.entries(MODES).map(([id, m]) => ({ icon: m.icon, label: m.label, checked: id === mode, action: () => setLayout(id) }))
    )
  );
  // Tab mới vào ô trống trước (gọi trước khi tab được kích hoạt).
  bus.on('tab-opened', (tab) => {
    touchMru(tab.key);
    const n = MODES[mode].slots;
    if (mode !== '1' && slots.length < n) {
      slots.push(tab.key);
      focus = slots.length - 1;
    }
  });
  // Chọn tab đang ẩn: thay vào ô đang focus. Tab đã có ô thì chỉ chuyển focus.
  bus.on('active-changed', (key) => {
    if (key !== 'home' && tabs.has(key)) {
      touchMru(key);
      if (mode !== '1') {
        const idx = slots.indexOf(key);
        if (idx >= 0) focus = idx;
        else {
          fillSlots();
          if (slots.length < MODES[mode].slots) slots.push(key);
          else slots[focus] = key;
          focus = slots.indexOf(key);
        }
      }
    }
    render();
  });
  bus.on('tab-closed', (tab) => {
    const i = mru.indexOf(tab.key);
    if (i >= 0) mru.splice(i, 1);
    const idx = slots.indexOf(tab.key);
    if (idx >= 0) {
      const repl = mru.find((k) => tabs.has(k) && !slots.includes(k));
      if (repl) slots[idx] = repl;
      else slots.splice(idx, 1);
    }
    render();
  });
  bus.on('multiexec-changed', render);
  fillSlots();
  render();
}

export { activate };
