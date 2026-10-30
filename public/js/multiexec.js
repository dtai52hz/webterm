// MultiExec: hiện mọi tab dạng lưới và gửi phím gõ tới tất cả tab đang tick.
import { $, toast } from './core/dom.js';
import { state, tabs, bus } from './state.js';
import { activate } from './term/tab.js';

export function setMultiExec(on) {
  state.multiExec = on;
  $('#btn-multiexec').setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('multiexec', on);
  if (on && state.activeKey === 'home' && tabs.size) activate([...tabs.keys()][0]);
  if (on && !tabs.size) toast('Hãy mở vài tab terminal trước rồi bật MultiExec', 'info');
  if (!on) activate(state.activeKey);
  requestAnimationFrame(() => tabs.forEach((t) => t.scheduleFit()));
  updateMultiUi();
  bus.emit('multiexec-changed', on);
}

export function updateMultiUi() {
  for (const t of tabs.values()) {
    t.paneEl.classList.toggle('multi-on', state.multiExec && t.multi);
    t.multiCheck.checked = t.multi;
  }
}

bus.on('tabs-changed', updateMultiUi);
