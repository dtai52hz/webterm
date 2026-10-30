import { $ } from './core/dom.js';
import { activate } from './term/tab.js';

export function initTabNavigation() {
  $('#tabbar').addEventListener('keydown', (e) => {
    if (!e.target.matches('.tab') || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    const items = [...$('#tabbar').querySelectorAll('.tab')];
    const index = items.indexOf(e.target);
    let next;
    if (e.key === 'ArrowLeft') next = items[(index - 1 + items.length) % items.length];
    else if (e.key === 'ArrowRight') next = items[(index + 1) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if (e.key === 'Enter' || e.key === ' ') next = e.target;
    if (!next) return;
    e.preventDefault();
    activate(next.dataset.tab, { focusTerminal: false });
    next.focus();
  });
}
