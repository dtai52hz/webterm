// Quản lý session: cây thư mục ở thanh bên, form tạo/sửa (SSH, RDP, terminal local), mở session.
import { $, $$, el, toast, copyText } from './core/dom.js';
import { api } from './core/api.js';
import { openModal, confirmDialog } from './core/dialogs.js';
import { showMenu } from './core/menu.js';
import { storage } from './core/storage.js';
import { targetLabel } from './core/format.js';
import { icon } from './core/icons.js';
import { state, bus } from './state.js';
import { TermTab } from './term/tab.js';

export const TYPE_ICON = { ssh: 'server', rdp: 'monitor', local: 'terminal' };
const DEFAULT_PORT = { ssh: 22, rdp: 3389 };

export async function loadSessions() {
  try {
    state.sessions = await api('GET', '/api/sessions');
  } catch (e) {
    if (e.status === 401) return bus.emit('locked-out', e.message);
    toast(e.message, 'error');
  }
  renderTree();
  renderRecent();
  $('#folder-list').replaceChildren(...[...new Set(state.sessions.map((s) => s.folder).filter(Boolean))].sort().map((f) => el('option', { value: f })));
  bus.emit('sessions-changed');
}

export function sessionSub(s) {
  const type = s.type || 'ssh';
  if (type === 'local') return `Terminal local · ${shellLabel(s.shell)}`;
  return `${type === 'rdp' ? 'RDP · ' : ''}${targetLabel(s.username, s.host, s.port, DEFAULT_PORT[type])}`;
}

function shellLabel(id) {
  const found = (state.shells || []).find((x) => x.id === id);
  return found ? found.name : id || 'PowerShell';
}

function sessionItem(s, showFolder) {
  const type = s.type || 'ssh';
  return el(
    'div',
    {
      class: `session-item${state.selectedSession === s.id ? ' selected' : ''}`,
      tabindex: 0,
      dataset: { id: s.id, type },
      title: `${s.name}\n${sessionSub(s)}${s.folder ? `\nThư mục: ${s.folder}` : ''}${s.notes ? `\n\n📝 ${s.notes}` : ''}\n\nDouble-click để ${type === 'rdp' ? 'mở Remote Desktop' : 'kết nối'}`,
      onclick: (e) => {
        state.selectedSession = s.id;
        $$('.session-item.selected').forEach((n) => n.classList.remove('selected'));
        e.currentTarget.classList.add('selected');
      },
      ondblclick: () => openSession(s),
      onkeydown: (e) => {
        if (e.target !== e.currentTarget) return;
        if (['Enter', 'Delete', 'F2'].includes(e.key)) e.preventDefault();
        if (e.key === 'Enter') openSession(s);
        if (e.key === 'Delete') deleteSession(s);
        if (e.key === 'F2') editSession(s);
      },
      oncontextmenu: (e) =>
        showMenu(e, [
          { icon: type === 'rdp' ? 'monitor' : 'play', label: type === 'rdp' ? 'Mở Remote Desktop' : 'Kết nối', action: () => openSession(s) },
          { icon: 'edit', label: 'Sửa session', action: () => editSession(s) },
          { icon: 'duplicate', label: 'Nhân bản', action: () => editSession(null, { ...s, name: `${s.name} (bản sao)` }) },
          type === 'ssh' && {
            icon: 'copy',
            label: 'Copy lệnh ssh',
            action: () => copyText(`ssh ${s.port !== 22 ? `-p ${s.port} ` : ''}${s.username ? s.username + '@' : ''}${s.host}`),
          },
          ...bus.collect('session-menu-extra', s),
          '-',
          { icon: 'trash', label: 'Xoá session', danger: true, action: () => deleteSession(s) },
        ]),
    },
    avatar(s),
    el(
      'div',
      { class: 'meta' },
      el('div', { class: 'name' }, el('span', { class: 'nm', text: s.name }), s.jumpSessionId ? icon('jump') : null, s.notes ? icon('note') : null),
      el('div', { class: 'sub', text: showFolder && s.folder ? `${s.folder} · ${sessionSub(s)}` : sessionSub(s) })
    ),
    el(
      'div',
      { class: 'row-actions' },
      el(
        'button',
        {
          class: 'icon-btn go',
          title: type === 'rdp' ? 'Mở Remote Desktop' : 'Kết nối',
          'aria-label': 'Kết nối',
          onclick: (e) => {
            e.stopPropagation();
            openSession(s);
          },
        },
        icon('play')
      ),
      el(
        'button',
        {
          class: 'icon-btn',
          title: 'Sửa',
          'aria-label': 'Sửa',
          onclick: (e) => {
            e.stopPropagation();
            editSession(s);
          },
        },
        icon('edit')
      )
    )
  );
}

// Ô vuông màu theo session, có icon kiểu kết nối.
export function avatar(s) {
  return el('span', { class: 'avatar', vars: s.color ? { '--c': s.color } : null }, icon(TYPE_ICON[s.type || 'ssh']));
}

export function renderTree() {
  const tree = $('#session-tree');
  const q = $('#session-search').value.trim().toLowerCase();
  if (!state.sessions.length) {
    tree.replaceChildren(
      el(
        'div',
        { class: 'empty' },
        icon('server', 'empty-icon'),
        'Chưa có session nào.',
        el('br'),
        el('button', { class: 'btn primary', onclick: () => editSession() }, icon('plus'), 'Tạo session'),
        el('button', { class: 'btn', onclick: () => bus.emit('open-import') }, icon('import'), 'Import MobaXterm')
      )
    );
    return;
  }
  if (q) {
    const hits = state.sessions.filter((s) => [s.name, s.host, s.username, s.folder, s.notes].some((v) => (v || '').toLowerCase().includes(q)));
    tree.replaceChildren(...(hits.length ? hits.map((s) => sessionItem(s, true)) : [el('div', { class: 'empty', text: 'Không tìm thấy.' })]));
    return;
  }
  const root = { folders: new Map(), items: [] };
  for (const s of state.sessions) {
    let node = root;
    for (const part of (s.folder || '').split('/').filter(Boolean)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), items: [] });
      node = node.folders.get(part);
    }
    node.items.push(s);
  }
  const closed = new Set(storage.get('wt.closedFolders', []));
  const count = (n) => n.items.length + [...n.folders.values()].reduce((a, f) => a + count(f), 0);
  const renderNode = (node, prefix) => [
    ...[...node.folders.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'vi'))
      .map(([name, child]) => {
        const full = prefix ? `${prefix}/${name}` : name;
        const det = el(
          'details',
          { open: !closed.has(full) },
          el('summary', {}, icon('chevron-right', 'chev'), icon('folder', 'fold'), el('span', { class: 'folder-name', text: name }), el('span', { class: 'count', text: String(count(child)) })),
          el('div', { class: 'folder-body' }, ...renderNode(child, full))
        );
        det.addEventListener('toggle', () => {
          const set = new Set(storage.get('wt.closedFolders', []));
          det.open ? set.delete(full) : set.add(full);
          storage.set('wt.closedFolders', [...set]);
        });
        return det;
      }),
    ...node.items.sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true })).map((s) => sessionItem(s, false)),
  ];
  tree.replaceChildren(...renderNode(root, ''));
}

export function renderRecent() {
  const ids = storage.get('wt.recent', []);
  const items = ids.map((id) => state.sessions.find((s) => s.id === id)).filter(Boolean);
  const box = $('#recent');
  if (!box) return;
  box.replaceChildren(
    ...(items.length
      ? items.map((s) =>
          el(
            'button',
            { class: 'recent-card', title: `Mở ${s.name}`, onclick: () => openSession(s) },
            avatar(s),
            el('div', { class: 'meta' }, el('div', { class: 'name', text: s.name }), el('div', { class: 'sub', text: sessionSub(s) }))
          )
        )
      : [el('div', { class: 'empty', text: 'Chưa mở session nào. Double-click một session ở thanh bên trái để bắt đầu.' })])
  );
}

function addRecent(id) {
  const ids = storage.get('wt.recent', []).filter((x) => x !== id);
  ids.unshift(id);
  storage.set('wt.recent', ids.slice(0, 8));
  renderRecent();
}

// ---------- Form tạo/sửa session ----------

let editing = null;
const form = () => $('#session-form');

function currentType() {
  return form().elements.type.value || 'ssh';
}

// Hiện/ẩn các trường theo kiểu session và kiểu xác thực.
function toggleFields() {
  const f = form();
  const type = currentType();
  const auth = f.elements.auth.value;
  const show = (sel, on) => $$(sel, f).forEach((n) => n.classList.toggle('hidden', !on));
  show('.t-ssh', type === 'ssh');
  show('.t-rdp', type === 'rdp');
  show('.t-local', type === 'local');
  show('.t-remote', type !== 'local');
  show('.t-password', type === 'rdp' || (type === 'ssh' && auth === 'password'));
  show('.t-key', type === 'ssh' && auth === 'key');
  show('.t-clear-password', Boolean(editing && editing.hasPassword) && (type === 'rdp' || (type === 'ssh' && auth === 'password')));
  show('.t-startdir', type !== 'rdp');
  f.elements.startDir.placeholder = type === 'local' ? 'C:\\Users\\hp\\Projects' : '/var/www';
  const port = f.elements.port;
  if (!port.dataset.touched) port.value = DEFAULT_PORT[type] || '';
}

function fillJumpOptions(selfId, value) {
  const sel = form().elements.jumpSessionId;
  const choices = state.sessions.filter((s) => (s.type || 'ssh') === 'ssh' && s.id !== selfId);
  sel.replaceChildren(el('option', { value: '', text: '(Không dùng)' }), ...choices.map((s) => el('option', { value: s.id, text: `${s.name} — ${sessionSub(s)}`, selected: s.id === value })));
}

function fillShellOptions(value) {
  const sel = form().elements.shell;
  const shells = state.shells || [];
  sel.replaceChildren(...(shells.length ? shells : [{ id: 'powershell', name: 'Windows PowerShell' }]).map((s) => el('option', { value: s.id, text: s.name, selected: s.id === value })));
}

export function editSession(s = null, preset = {}) {
  const f = form();
  f.reset();
  editing = s;
  $('#session-form-title').textContent = s ? `Sửa session: ${s.name}` : 'Session mới';
  const v = s || { type: 'ssh', auth: 'password', color: '#3b9eff', ...preset };
  const type = v.type || 'ssh';
  f.elements.type.value = type;
  for (const k of ['name', 'folder', 'host', 'username', 'privateKeyPath', 'startDir', 'loginCommand', 'notes']) f.elements[k].value = v[k] ?? '';
  f.elements.auth.value = v.auth || 'password';
  f.elements.port.value = v.port || DEFAULT_PORT[type] || '';
  f.elements.port.dataset.touched = v.port && v.port !== DEFAULT_PORT[type] ? '1' : '';
  f.elements.rdpAuth.value = v.rdpAuth || 'dpapi';
  f.elements.rdpFullscreen.checked = Boolean(v.rdpFullscreen);
  f.elements.color.value = v.color || '#3b9eff';
  f.elements.password.placeholder = s && s.hasPassword ? '•••••• đã lưu (để trống = giữ nguyên)' : 'Để trống = hỏi khi kết nối';
  f.elements.passphrase.placeholder = s && s.hasPassphrase ? '•••••• đã lưu' : '';
  // Chạy từ USB: chỉ cần tên file trong WebTerm-data\keys, session dùng được ở mọi máy.
  f.elements.privateKeyPath.placeholder = state.capabilities.portable
    ? 'id_ed25519 (file trong WebTerm-data\\keys trên USB)'
    : 'id_ed25519 (trong thư mục .ssh) hoặc đường dẫn đầy đủ';
  fillJumpOptions(s && s.id, v.jumpSessionId || '');
  fillShellOptions(v.shell);
  // RDP và terminal local cần chạy trên chính máy này.
  $$('.needs-local', f).forEach((n) => n.classList.toggle('hidden', !state.capabilities.localFeatures && type === 'ssh'));
  toggleFields();
  openModal($('#dlg-session'));
  f.elements.host.value || type === 'local' ? f.elements.name.focus() : f.elements.host.focus();
}

async function submitSession(e) {
  const action = e.submitter ? e.submitter.value : 'save';
  if (action === 'cancel') return;
  e.preventDefault();
  const f = e.target.elements;
  const type = currentType();
  const payload = {
    type,
    name: f.name.value,
    folder: f.folder.value,
    color: f.color.value,
    notes: f.notes.value,
  };
  if (type === 'local') Object.assign(payload, { shell: f.shell.value, startDir: f.startDir.value });
  else Object.assign(payload, { host: f.host.value, port: Number(f.port.value) || DEFAULT_PORT[type], username: f.username.value });
  if (type === 'ssh') {
    Object.assign(payload, {
      auth: f.auth.value,
      privateKeyPath: f.privateKeyPath.value,
      startDir: f.startDir.value,
      loginCommand: f.loginCommand.value,
      jumpSessionId: f.jumpSessionId.value,
    });
    if (f.passphrase.value) payload.passphrase = f.passphrase.value;
  }
  if (type === 'rdp') Object.assign(payload, { rdpAuth: f.rdpAuth.value, rdpFullscreen: f.rdpFullscreen.checked });
  if (type !== 'local') {
    if (f.clearPassword.checked) payload.password = '';
    else if (f.password.value) payload.password = f.password.value;
  }
  try {
    const saved = editing ? await api('PUT', `/api/sessions/${editing.id}`, payload) : await api('POST', '/api/sessions', payload);
    $('#dlg-session').close('saved');
    toast(`Đã lưu "${saved.name}"`, 'ok');
    await loadSessions();
    if (action === 'save-connect') openSession(saved);
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function deleteSession(s) {
  if (!(await confirmDialog('Xoá session?', `Xoá "${s.name}" (${sessionSub(s)}) khỏi danh sách? Mật khẩu đã lưu cũng bị xoá.`, 'Xoá', true))) return;
  try {
    await api('DELETE', `/api/sessions/${s.id}`);
    toast(`Đã xoá "${s.name}"`, 'ok');
    loadSessions();
  } catch (e) {
    toast(e.message, 'error');
  }
}

export function openSession(s) {
  addRecent(s.id);
  const type = s.type || 'ssh';
  if (type === 'rdp') return bus.emit('launch-rdp', s);
  if (type === 'local') {
    return new TermTab({ kind: 'local', sessionId: s.id, name: s.name, shell: s.shell, startDir: s.startDir, color: s.color, windowsPty: state.windowsPty });
  }
  return new TermTab({
    kind: 'ssh',
    sessionId: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    username: s.username,
    auth: s.auth,
    hasPassword: s.hasPassword,
    color: s.color,
    startDir: s.startDir,
  });
}

export function initSessions() {
  const f = form();
  f.elements.auth.addEventListener('change', toggleFields);
  $$('input[name=type]', f).forEach((r) => r.addEventListener('change', toggleFields));
  f.elements.port.addEventListener('input', () => (f.elements.port.dataset.touched = '1'));
  f.addEventListener('submit', submitSession);
  $('#session-search').addEventListener('input', renderTree);
  bus.on('sessions-reload', loadSessions);
  bus.on('save-as-session', (preset) => editSession(null, preset));
}
