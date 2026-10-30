// Thanh trạng thái: thông số server của tab đang chọn (giống remote monitoring của MobaXterm).
import { $, el } from './core/dom.js';
import { fmtBytes, fmtUptime } from './core/format.js';
import { icon } from './core/icons.js';
import { state, tabs, bus, activeTab } from './state.js';

function meter(iconName, label, pct, text, cls) {
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return el(
    'span',
    { class: `stat ${cls}`, title: `${label}: ${text}` },
    icon(iconName),
    el('span', { class: 'label', text: label }),
    el('span', { class: `meter${p > 85 ? ' high' : p > 60 ? ' mid' : ''}` }, el('i', { style: { width: `${p}%` } })),
    el('span', { text })
  );
}

const stat = (iconName, label, text, cls) => el('span', { class: `stat ${cls}`, title: label }, icon(iconName), el('span', { text }));

export function renderStatus() {
  const parts = [];
  if (state.multiExec) {
    const n = [...tabs.values()].filter((t) => t.multi && t.status === 'connected').length;
    parts.push(el('span', { class: 'multi-banner', title: `Phím gõ được gửi tới ${n} tab đang tick` }, icon('broadcast'), `MultiExec · ${n} tab`));
  }
  const tab = activeTab();
  if (!tab) {
    parts.push(el('span', { class: 'muted', text: tabs.size ? `${tabs.size} tab đang mở` : 'Chưa có kết nối' }));
  } else {
    parts.push(el('span', { class: `host${tab.status === 'connected' ? ' on' : ''}`, text: tab.label }));
    const s = tab.stats;
    if (tab.status === 'connecting') parts.push(el('span', { class: 'muted', text: 'Đang kết nối…' }));
    else if (tab.status !== 'connected') parts.push(el('span', { class: 'muted', text: 'Đã ngắt kết nối' }));
    else if (tab.target.kind === 'local') parts.push(el('span', { class: 'muted', text: 'Terminal local trên máy này' }));
    else if (tab.statsUnsupported) parts.push(el('span', { class: 'muted', text: 'Không có dữ liệu giám sát (server không phải Linux?)' }));
    else if (!s) parts.push(el('span', { class: 'muted', text: 'Đang lấy thông số…' }));
    else {
      parts.push(
        meter('cpu', 'CPU', s.cpu, s.cpu == null ? '…' : `${s.cpu.toFixed(0)}%`, 'st-cpu'),
        meter('memory', 'RAM', s.memTotal ? (s.memUsed / s.memTotal) * 100 : null, `${fmtBytes(s.memUsed)} / ${fmtBytes(s.memTotal)}`, 'st-ram'),
        meter('disk', 'Disk', s.diskTotal ? (s.diskUsed / s.diskTotal) * 100 : null, `${fmtBytes(s.diskUsed)} / ${fmtBytes(s.diskTotal)}`, 'st-disk'),
        stat('network', 'Mạng', `↓ ${s.rxRate == null ? '…' : fmtBytes(s.rxRate) + '/s'}  ↑ ${s.txRate == null ? '…' : fmtBytes(s.txRate) + '/s'}`, 'st-net'),
        stat('activity', 'Load average', (s.load || []).map((n) => n.toFixed(2)).join(' '), 'st-load'),
        stat('clock', 'Uptime', fmtUptime(s.uptime), 'st-uptime')
      );
    }
  }
  $('#statusbar').replaceChildren(...parts);
}

bus.on('active-changed', renderStatus);
bus.on('tabs-changed', renderStatus);
bus.on('multiexec-changed', renderStatus);
bus.on('tab-status', (tab) => (state.activeKey === tab.key || state.multiExec) && renderStatus());
bus.on('tab-stats', (tab) => state.activeKey === tab.key && renderStatus());
