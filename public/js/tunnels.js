// Quản lý SSH tunnel (giống MobaSSHTunnel): bảng tunnel, tạo/sửa, chạy/dừng, tin tưởng host key.
import { $, el, toast } from './core/dom.js';
import { api } from './core/api.js';
import { openModal, confirmDialog, hostKeyDialog } from './core/dialogs.js';
import { fmtBytes } from './core/format.js';
import { icon } from './core/icons.js';
import { state, bus } from './state.js';

let list = [];
let editing = null;

const STATUS = {
  stopped: 'Đã dừng',
  starting: 'Đang mở…',
  running: 'Đang chạy',
  reconnecting: 'Đang nối lại…',
  locked: 'Chờ mở khoá',
  error: 'Lỗi',
};
const TYPE = { L: 'Local -L', R: 'Remote -R', D: 'SOCKS -D' };

const listenText = (t) => (t.type === 'R' ? `server ${t.bindHost}:${t.bindPort}` : `${t.bindHost}:${t.bindPort}`);
const destText = (t) => (t.type === 'D' ? 'SOCKS5 (mọi đích)' : t.type === 'R' ? `máy này → ${t.destHost}:${t.destPort}` : `${t.destHost}:${t.destPort}`);

async function load() {
  try {
    list = await api('GET', '/api/tunnels');
  } catch (e) {
    toast(e.message, 'error');
  }
  render();
}

async function act(t, action) {
  try {
    await api('POST', `/api/tunnels/${t.id}/${action}`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function trust(t) {
  const hk = t.hostKey;
  if (!hk) return;
  if (!(await hostKeyDialog(hk))) return;
  try {
    await api('POST', '/api/known-hosts/trust', { host: hk.host, port: hk.port, via: hk.via, fingerprint: hk.fingerprint });
    toast('Đã tin tưởng host key, đang chạy lại tunnel', 'ok');
    act(t, 'start');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function remove(t) {
  if (!(await confirmDialog('Xoá tunnel?', `Xoá "${t.name}"? Tunnel đang chạy sẽ bị dừng.`, 'Xoá', true))) return;
  try {
    await api('DELETE', `/api/tunnels/${t.id}`);
  } catch (e) {
    toast(e.message, 'error');
  }
  load();
}

const iconBtn = (name, title, onclick) => el('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, onclick }, icon(name));

function row(t) {
  const running = ['running', 'starting', 'reconnecting', 'locked'].includes(t.status);
  return el(
    'tr',
    {},
    el('td', { class: 'tname', title: t.autoStart ? 'Tự chạy khi mở WebTerm' : '' }, t.autoStart ? icon('zap') : null, t.name),
    el('td', {}, el('span', { class: 'ttype', text: TYPE[t.type] })),
    el('td', { class: 'mono', text: listenText(t) }),
    el('td', { text: t.sessionName, title: t.sessionLabel }),
    el('td', { class: 'mono', text: destText(t) }),
    el(
      'td',
      {},
      el('span', { class: `tstatus ${t.status}`, text: STATUS[t.status] || t.status }),
      t.status === 'running' && (t.connections || t.bytesIn || t.bytesOut)
        ? el('div', { class: 'muted small tmeta', text: `${t.connections} kết nối · ↓ ${fmtBytes(t.bytesIn)} ↑ ${fmtBytes(t.bytesOut)}` })
        : null,
      t.error ? el('div', { class: 'err small', text: t.error }) : null
    ),
    el(
      'td',
      {},
      el(
        'div',
        { class: 'actions' },
        t.errorCode === 'hostkey-unknown' && t.hostKey ? el('button', { class: 'btn', type: 'button', onclick: () => trust(t) }, icon('shield-check'), 'Tin tưởng…') : null,
        running ? iconBtn('stop', 'Dừng', () => act(t, 'stop')) : iconBtn('play', 'Chạy', () => act(t, 'start')),
        iconBtn('edit', 'Sửa', () => editTunnel(t)),
        iconBtn('trash', 'Xoá', () => remove(t))
      )
    )
  );
}

function render() {
  const body = $('#tunnel-rows');
  if (!body) return;
  body.replaceChildren(
    ...(list.length
      ? list.map(row)
      : [el('tr', {}, el('td', { colspan: 7 }, el('div', { class: 'empty' }, icon('tunnel', 'empty-icon'), 'Chưa có tunnel. Ví dụ: mở cổng 13306 trên máy này tới MySQL 3306 của VPS.')))])
  );
  const running = list.filter((t) => t.status === 'running').length;
  const badge = $('#tunnel-badge');
  badge.hidden = !running;
  badge.textContent = String(running);
}

const HELP = {
  L: 'Mở cổng trên máy này. Kết nối vào {bind} sẽ được chuyển qua server SSH tới {dest}.\nVí dụ MySQL: cổng nghe 13306, máy đích 127.0.0.1, cổng đích 3306 → dùng HeidiSQL/DBeaver kết nối 127.0.0.1:13306.',
  R: 'Mở cổng trên server SSH. Kết nối vào cổng đó trên server sẽ đi ngược về {dest} phía máy này.\nNghe trên địa chỉ khác 127.0.0.1 cần server bật GatewayPorts.',
  D: 'Proxy SOCKS5 tại {bind}. Đặt proxy này trong trình duyệt/app để mọi truy cập đi qua server SSH (DNS phân giải phía server).',
};

function updateHelp() {
  const f = $('#tunnel-form').elements;
  const type = f.type.value;
  $('#tunnel-form')
    .querySelectorAll('.t-dest')
    .forEach((n) => n.classList.toggle('hidden', type === 'D'));
  const bind = `${f.bindHost.value || '127.0.0.1'}:${f.bindPort.value || '?'}`;
  const dest = `${f.destHost.value || '?'}:${f.destPort.value || '?'}`;
  let text = HELP[type].replace('{bind}', bind).replace('{dest}', dest);
  if (type !== 'R' && !['127.0.0.1', 'localhost', '::1'].includes(f.bindHost.value.trim())) {
    text += '\n⚠ Nghe trên địa chỉ khác 127.0.0.1 nghĩa là máy khác trong mạng cũng dùng được tunnel này, và Windows Firewall có thể hỏi cấp quyền.';
  }
  $('#tunnel-help').textContent = text;
}

export function editTunnel(t = null, preset = {}) {
  const f = $('#tunnel-form');
  f.reset();
  editing = t;
  $('#tunnel-form-title').textContent = t ? `Sửa tunnel: ${t.name}` : 'Tunnel mới';
  const v = t || { type: 'L', bindHost: '127.0.0.1', destHost: '127.0.0.1', ...preset };
  const sshSessions = state.sessions.filter((s) => (s.type || 'ssh') === 'ssh');
  f.elements.sessionId.replaceChildren(
    ...(sshSessions.length ? sshSessions.map((s) => el('option', { value: s.id, text: `${s.name} — ${s.username ? s.username + '@' : ''}${s.host}`, selected: v.sessionId === s.id })) : [el('option', { value: '', text: '(Chưa có session SSH nào)' })])
  );
  for (const k of ['name', 'type', 'bindHost', 'bindPort', 'destHost', 'destPort']) f.elements[k].value = v[k] ?? '';
  f.elements.autoStart.checked = Boolean(v.autoStart);
  updateHelp();
  openModal($('#dlg-tunnel'));
  f.elements.name.focus();
}

export async function openTunnels() {
  await load();
  openModal($('#dlg-tunnels'));
}

export function initTunnels() {
  $('#btn-tunnels').addEventListener('click', openTunnels);
  $('#tunnels-close').addEventListener('click', () => $('#dlg-tunnels').close());
  $('#tunnel-new').addEventListener('click', () => editTunnel());
  const f = $('#tunnel-form');
  for (const k of ['type', 'bindHost', 'bindPort', 'destHost', 'destPort']) f.elements[k].addEventListener('input', updateHelp);
  f.addEventListener('submit', async (e) => {
    const action = e.submitter ? e.submitter.value : 'save';
    if (action === 'cancel') return;
    e.preventDefault();
    const el2 = f.elements;
    const payload = {
      name: el2.name.value,
      type: el2.type.value,
      sessionId: el2.sessionId.value,
      bindHost: el2.bindHost.value,
      bindPort: Number(el2.bindPort.value),
      destHost: el2.destHost.value,
      destPort: Number(el2.destPort.value),
      autoStart: el2.autoStart.checked,
    };
    try {
      const saved = editing ? await api('PUT', `/api/tunnels/${editing.id}`, payload) : await api('POST', '/api/tunnels', payload);
      $('#dlg-tunnel').close('saved');
      if (!editing) act(saved, 'start');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  bus.on('sse:tunnels', (data) => {
    if (!Array.isArray(data)) return;
    list = data;
    render();
  });
  bus.provide('session-menu-extra', (s) =>
    (s.type || 'ssh') === 'ssh' ? [{ icon: 'tunnel', label: 'Tạo tunnel qua server này', action: () => editTunnel(null, { sessionId: s.id }) }] : []
  );
  load();
}
