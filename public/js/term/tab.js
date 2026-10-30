/* global Terminal, FitAddon, WebLinksAddon */
// Một tab terminal: xterm.js + WebSocket tới server (SSH hoặc shell local).
import { $, $$, el, toast } from '../core/dom.js';
import { hostKeyDialog, promptDialog } from '../core/dialogs.js';
import { showMenu } from '../core/menu.js';
import { targetLabel } from '../core/format.js';
import { icon } from '../core/icons.js';
import { state, tabs, bus } from '../state.js';
import { prefs } from '../prefs.js';
import { themeOf } from './themes.js';
import { attachSearch } from './search.js';

const encoder = new TextEncoder();
const WS_CHUNK = 64 * 1024; // server giới hạn 1 MB mỗi frame; paste dài được chia nhỏ
let tabSeq = 0;

function termOptions() {
  const p = prefs();
  return {
    cursorBlink: p.cursorBlink,
    cursorStyle: p.cursorStyle,
    fontFamily: p.fontFamily,
    fontSize: p.fontSize,
    scrollback: p.scrollback,
    theme: themeOf(p.theme).theme,
  };
}

export class TermTab {
  // target: {kind:'ssh'|'local', sessionId, name, host, port, username, auth, hasPassword, color, startDir, shell}
  constructor(target) {
    this.key = `t${++tabSeq}`;
    this.target = { kind: 'ssh', ...target };
    this.status = 'connecting';
    this.connId = null;
    this.ws = null;
    this.connectAttempt = null;
    this.disposed = false;
    this.stats = null;
    this.statsUnsupported = false;
    this.monitorOn = false;
    this.multi = true;
    this.creds = {};
    this.forcePrompt = false;
    this.sftp = { cwd: null, entries: [], selected: new Set(), anchor: null, loading: false, error: null, follow: false };
    this.lastSize = '';

    this.tabEl = el(
      'div',
      {
        class: 'tab',
        role: 'tab',
        id: `tab-${this.key}`,
        tabindex: -1,
        'aria-selected': 'false',
        'aria-controls': `pane-${this.key}`,
        dataset: { tab: this.key, status: 'connecting', kind: this.target.kind },
        title: this.label,
        vars: target.color ? { '--tab-color': target.color } : null,
        onclick: () => activate(this.key),
        onauxclick: (e) => e.button === 1 && this.close(),
        oncontextmenu: (e) => this.menu(e),
      },
      (this.multiCheck = el('input', {
        type: 'checkbox',
        class: 'multi-check',
        checked: true,
        title: 'Nhận lệnh MultiExec',
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => {
          this.multi = e.target.checked;
          bus.emit('tabs-changed');
        },
      })),
      el('span', { class: 'tab-icon' }, icon(this.target.kind === 'local' ? 'terminal' : 'server'), el('span', { class: 'status' })),
      (this.nameEl = el('span', { class: 'tab-name', text: target.name })),
      el(
        'button',
        {
          class: 'tab-close',
          title: 'Đóng tab',
          'aria-label': 'Đóng tab',
          onclick: (e) => {
            e.stopPropagation();
            this.close();
          },
        },
        icon('x')
      )
    );
    this.paneEl = el(
      'section',
      { class: 'pane term-pane', id: `pane-${this.key}`, role: 'tabpanel', 'aria-labelledby': `tab-${this.key}`, dataset: { tab: this.key }, onmousedown: () => state.activeKey !== this.key && activate(this.key) },
      (this.labelEl = el('div', { class: 'pane-label' }, icon(this.target.kind === 'local' ? 'terminal' : 'server'), (this.labelText = el('span', { text: target.name })))),
      (this.hostEl = el('div', { class: 'term-host' }))
    );
    $('#tabbar').append(this.tabEl);
    $('#panes').append(this.paneEl);
    tabs.set(this.key, this);
    try {
      bus.emit('tab-opened', this);
      activate(this.key);
      this.initTerminal();
    } catch (e) {
      this.initializationFailed = true;
      this.close();
      throw e;
    }
  }

  initTerminal() {
    // Mở terminal sau khi pane đã hiển thị để xterm đo được kích thước.
    // allowProposedApi: cần cho registerDecoration (tô màu từ khoá).
    this.term = new Terminal({ ...termOptions(), allowProposedApi: true, ...(this.target.windowsPty ? { windowsPty: this.target.windowsPty } : {}) });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    this.term.open(this.hostEl);
    this.search = attachSearch(this);
    // Ctrl+F mở thanh tìm kiếm khi đang ở shell; trong vim/htop/nano (màn hình phụ) Ctrl+F vẫn gửi cho chương trình.
    // Ctrl+Shift+F thì luôn mở tìm kiếm.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey || e.key.toLowerCase() !== 'f') return true;
      if (!e.shiftKey && this.term.buffer.active.type !== 'normal') return true;
      e.preventDefault();
      this.search.open();
      return false;
    });
    this.term.onData((d) => this.input(d));
    this.term.onBinary((d) => this.sendBytes(Uint8Array.from(d, (c) => c.charCodeAt(0) & 255)));
    // Bôi đen là copy, chuột phải là dán (giống MobaXterm/PuTTY), có thể tắt trong Cài đặt.
    this.term.onSelectionChange(() => {
      const sel = this.term.getSelection();
      if (performance.now() < (this.suppressCopyUntil || 0)) return; // chữ được bôi đen do nhảy tới kết quả tìm kiếm
      if (sel && prefs().copyOnSelect && navigator.clipboard) navigator.clipboard.writeText(sel).catch(() => {});
    });
    this.term.onTitleChange((title) => (this.tabEl.title = `${this.label}\n${title}`));
    // Shell tự báo thư mục hiện tại: OSC 7 (file://host/path), OSC 633 (;P;Cwd=), OSC 1337 (;CurrentDir=).
    const oscCwd = (path) => path && path.startsWith('/') && bus.emit('osc-cwd', { tab: this, path });
    this.term.parser.registerOscHandler(7, (data) => {
      const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
      if (m) {
        try {
          oscCwd(decodeURIComponent(m[1]));
        } catch {}
      }
      return true;
    });
    this.term.parser.registerOscHandler(633, (data) => {
      const m = data.match(/^P;Cwd=(.*)$/);
      if (m) oscCwd(m[1]);
      return false;
    });
    this.term.parser.registerOscHandler(1337, (data) => {
      const m = data.match(/^CurrentDir=(.*)$/);
      if (m) oscCwd(m[1]);
      return false;
    });
    this.hostEl.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    // Ctrl + lăn chuột để đổi cỡ chữ cho mọi tab.
    this.hostEl.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        bus.emit('font-step', e.deltaY < 0 ? 1 : -1);
      },
      { passive: false }
    );
    this.resizeObs = new ResizeObserver(() => this.scheduleFit());
    this.resizeObs.observe(this.hostEl);
    this.doFit();
    this.term.focus();
    bus.emit('term-created', this);
    bus.emit('tabs-changed');
    this.connect();
  }

  get label() {
    if (this.target.kind === 'local') return this.target.name;
    return targetLabel(this.creds.username || this.target.username, this.target.host, this.target.port);
  }

  async onContextMenu(e) {
    e.preventDefault();
    if (!prefs().rightClickPaste) {
      const sel = this.term.getSelection();
      showMenu(e, [
        { icon: 'copy', label: 'Copy', disabled: !sel, action: () => navigator.clipboard.writeText(sel).catch(() => {}) },
        { icon: 'file-text', label: 'Dán', action: () => this.pasteFromClipboard() },
        '-',
        { icon: 'search', label: 'Tìm… (Ctrl+F)', action: () => this.search.open() },
        { label: 'Chọn tất cả', action: () => this.term.selectAll() },
        { label: 'Xoá màn hình', action: () => this.term.clear() },
      ]);
      return;
    }
    this.pasteFromClipboard();
  }

  async pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text && !this.disposed) this.term.paste(text);
    } catch {
      toast('Trình duyệt chặn đọc clipboard, hãy dùng Ctrl+V', 'error');
    }
  }

  applySettings() {
    const opts = termOptions();
    for (const [k, v] of Object.entries(opts)) this.term.options[k] = v;
    this.scheduleFit();
  }

  menu(e) {
    showMenu(e, [
      { icon: 'refresh', label: 'Kết nối lại', action: () => this.reconnect() },
      { icon: 'duplicate', label: 'Nhân bản tab', action: () => new TermTab({ ...this.target, username: this.creds.username || this.target.username }) },
      { icon: 'edit', label: 'Đổi tên tab', action: () => this.rename() },
      !this.target.sessionId &&
        this.target.kind === 'ssh' && {
          icon: 'save',
          label: 'Lưu thành session',
          action: () =>
            bus.emit('save-as-session', { name: this.target.name, host: this.target.host, port: this.target.port, username: this.creds.username || this.target.username }),
        },
      '-',
      { icon: 'search', label: 'Tìm trong terminal (Ctrl+F)', action: () => this.search.open() },
      { label: 'Xoá màn hình', action: () => this.term.clear() },
      { icon: 'x', label: 'Đóng tab', action: () => this.close() },
      { label: 'Đóng các tab khác', action: () => [...tabs.values()].filter((t) => t !== this).forEach((t) => t.close()) },
    ]);
  }

  async rename() {
    const r = await promptDialog({ title: 'Đổi tên tab', fields: [{ name: 'name', label: 'Tên', value: this.labelText.textContent }] });
    if (!this.disposed && r && r.name.trim()) {
      this.setName(r.name.trim());
    }
  }

  setName(name) {
    this.nameEl.textContent = name;
    this.labelText.textContent = name;
    this.tabEl.title = `${name}\n${this.label}`;
    bus.emit('tabs-changed');
  }

  setStatus(s) {
    this.status = s;
    this.tabEl.dataset.status = s;
    bus.emit('tab-status', this);
  }

  scheduleFit() {
    if (this.disposed) return;
    cancelAnimationFrame(this.fitRaf);
    this.fitRaf = requestAnimationFrame(() => this.doFit());
  }

  doFit() {
    if (this.disposed || !this.term || this.hostEl.clientWidth < 20 || this.hostEl.clientHeight < 20) return;
    try {
      this.fit.fit();
    } catch {}
    const size = `${this.term.cols}x${this.term.rows}`;
    if (size !== this.lastSize) {
      this.lastSize = size;
      this.control({ type: 'resize', cols: this.term.cols, rows: this.term.rows });
      bus.emit('term-resized', this);
    }
  }

  control(obj, ws = this.ws, attempt = this.connectAttempt) {
    if (this.isCurrentAttempt(attempt, ws) && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  sendBytes(bytes) {
    if (this.status !== 'connected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (let i = 0; i < bytes.length; i += WS_CHUNK) this.ws.send(bytes.subarray(i, i + WS_CHUNK));
  }

  sendText(text) {
    this.sendBytes(encoder.encode(text));
  }

  // MultiExec: phím gõ ở một tab được gửi tới mọi tab đang bật ô "nhận lệnh".
  input(d) {
    if (this.disposed) return;
    if (this.status === 'closed' || this.status === 'error') {
      if (d === 'r' || d === 'R') this.reconnect();
      return;
    }
    bus.emit('term-input', { tab: this, data: d });
    if (state.multiExec && this.multi) {
      for (const t of tabs.values()) if (t.multi) t.sendText(d);
    } else this.sendText(d);
  }

  async connect() {
    if (this.disposed) return;
    this.stopConnection();
    const attempt = (this.connectAttempt = new AbortController());
    // Đánh dấu trước khi hỏi mật khẩu: nhấn R liên tiếp không xếp hàng nhiều lần đăng nhập.
    this.setStatus('connecting');
    const t = this.target;
    let { username, password, savePassword } = this.creds;
    if (t.kind === 'ssh') {
      username = username || t.username;
      const needPassword = (t.auth || 'password') === 'password' && !password && (!t.hasPassword || this.forcePrompt);
      if (!username || needPassword) {
        const fields = [];
        if (!username) fields.push({ name: 'username', label: 'Username', placeholder: 'root' });
        if (needPassword) fields.push({ name: 'password', label: 'Mật khẩu', type: 'password' });
        if (needPassword && t.sessionId) fields.push({ name: 'savePassword', label: 'Lưu mật khẩu cho session này (mã hoá trên máy)', type: 'checkbox', value: false });
        const r = await promptDialog({
          title: `Đăng nhập ${t.host}${t.port && Number(t.port) !== 22 ? ':' + t.port : ''}`,
          message: username ? `User: ${username}` : '',
          fields,
          okText: 'Kết nối',
          signal: attempt.signal,
        });
        if (!this.isCurrentAttempt(attempt)) return;
        if (!r) {
          this.setStatus('closed');
          this.term.write('\x1b[33mĐã huỷ. Bấm R để thử lại.\x1b[0m\r\n');
          return;
        }
        username = (r.username || username || '').trim();
        if (needPassword) password = r.password;
        savePassword = r.savePassword;
      }
      this.creds = { ...this.creds, username, password, savePassword };
      this.forcePrompt = false;
      this.term.write(`\x1b[90mĐang kết nối tới ${targetLabel(username, t.host, t.port)} …\x1b[0m\r\n`);
    } else {
      this.term.write(`\x1b[90mĐang mở ${t.name} …\x1b[0m\r\n`);
    }
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (!this.isCurrentAttempt(attempt, ws)) return;
      ws.send(
        JSON.stringify({
          type: 'connect',
          kind: t.kind,
          sessionId: t.sessionId,
          host: t.host,
          port: t.port,
          username,
          password: password || undefined,
          savePassword: Boolean(savePassword),
          shell: t.shell,
          cwd: t.startDir,
          jumpPassword: this.creds.jumpPassword,
          cols: this.term.cols,
          rows: this.term.rows,
        })
      );
    };
    ws.onmessage = (ev) => {
      if (!this.isCurrentAttempt(attempt, ws)) return;
      if (typeof ev.data !== 'string') return this.term.write(new Uint8Array(ev.data));
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onControl(msg, ws, attempt);
    };
    ws.onclose = () => {
      if (!this.isCurrentAttempt(attempt, ws)) return;
      if (this.status === 'connected' || this.status === 'connecting') this.onClosed();
    };
  }

  isCurrentAttempt(attempt, ws) {
    return !this.disposed && Boolean(attempt) && attempt === this.connectAttempt && !attempt.signal.aborted && (ws === undefined || ws === this.ws);
  }

  stopConnection() {
    const attempt = this.connectAttempt;
    const ws = this.ws;
    this.connectAttempt = null;
    this.ws = null;
    if (attempt) attempt.abort();
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.close();
    }
  }

  async onControl(msg, ws = this.ws, attempt = this.connectAttempt) {
    if (!this.isCurrentAttempt(attempt, ws)) return;
    switch (msg.type) {
      case 'hostkey': {
        const ok = await hostKeyDialog(msg, { signal: attempt.signal });
        if (!this.isCurrentAttempt(attempt, ws)) return;
        this.control({ type: 'hostkey-reply', accept: ok }, ws, attempt);
        if (!ok) this.term.write('\x1b[33mĐã từ chối host key.\x1b[0m\r\n');
        break;
      }
      case 'ask':
        return this.onAsk(msg, ws, attempt);
      case 'ready':
        this.connId = msg.id;
        this.lastSize = '';
        this.setStatus('connected');
        this.doFit();
        if (this.creds.savePassword && this.target.sessionId) {
          this.target.hasPassword = true;
          bus.emit('sessions-reload');
        }
        if (state.activeKey === this.key) {
          this.setMonitor(true);
          if (this.target.kind === 'ssh') bus.emit('side', 'sftp');
        }
        bus.emit('tabs-changed');
        break;
      case 'error':
        this.stopConnection();
        this.monitorOn = false;
        this.stats = null;
        this.statsUnsupported = false;
        this.setStatus('error');
        this.term.write(`\r\n\x1b[31m✖ ${msg.message}\x1b[0m\r\n`);
        if (msg.code === 'auth' || msg.code === 'need-password') {
          this.creds.password = undefined;
          this.forcePrompt = true;
          this.term.write('\x1b[33mBấm R để nhập lại thông tin đăng nhập.\x1b[0m\r\n');
        } else if (msg.code === 'need-username') {
          this.creds.username = undefined;
          this.target.username = '';
          this.term.write('\x1b[33mBấm R để nhập username.\x1b[0m\r\n');
        } else if (msg.code === 'locked') {
          this.term.write('\x1b[33mMở khoá master password (biểu tượng 🔒 trên thanh công cụ) rồi bấm R.\x1b[0m\r\n');
          bus.emit('vault-locked');
        } else {
          this.term.write('\x1b[33mBấm R để thử lại.\x1b[0m\r\n');
        }
        this.connId = null;
        bus.emit('tabs-changed');
        break;
      case 'closed':
        this.onClosed();
        break;
      case 'stats':
        if (msg.unsupported) this.statsUnsupported = true;
        else this.stats = msg;
        bus.emit('tab-stats', this);
        break;
      default:
        bus.emit(`ws:${msg.type}`, { tab: this, msg });
    }
  }

  // Giao thức hỏi/đáp: server cần người dùng xác nhận host key, nhập mật khẩu jump host, OTP...
  async onAsk(msg, ws = this.ws, attempt = this.connectAttempt) {
    if (!this.isCurrentAttempt(attempt, ws)) return;
    let answer = { type: 'answer', id: msg.id };
    if (msg.kind === 'hostkey') {
      const ok = await hostKeyDialog(msg, { signal: attempt.signal });
      if (!this.isCurrentAttempt(attempt, ws)) return;
      answer.accept = ok;
      if (!ok) this.term.write('\x1b[33mĐã từ chối host key.\x1b[0m\r\n');
    } else {
      const r = await promptDialog({
        title: msg.title || 'Server yêu cầu nhập thông tin',
        message: msg.message || '',
        fields: (msg.prompts || [{ prompt: 'Mật khẩu', echo: false }]).map((p, i) => ({ name: `a${i}`, label: p.prompt, type: p.echo ? 'text' : 'password' })),
        okText: 'Gửi',
        signal: attempt.signal,
      });
      if (!this.isCurrentAttempt(attempt, ws)) return;
      answer.cancel = !r;
      answer.values = r ? (msg.prompts || [{}]).map((_, i) => r[`a${i}`]) : [];
      if (r && msg.kind === 'secret' && msg.hop) this.creds.jumpPassword = answer.values[0];
    }
    this.control(answer, ws, attempt);
  }

  onClosed() {
    if (this.disposed || this.status === 'closed') return;
    this.stopConnection();
    this.connId = null;
    this.monitorOn = false;
    this.stats = null;
    this.statsUnsupported = false;
    this.term.write('\r\n\x1b[33m— Phiên đã đóng. Bấm R để kết nối lại. —\x1b[0m\r\n');
    this.setStatus('closed');
    bus.emit('tabs-changed');
  }

  reconnect() {
    if (this.disposed) return;
    this.connId = null;
    this.stats = null;
    this.statsUnsupported = false;
    this.monitorOn = false;
    this.sftp = { ...this.sftp, cwd: null, entries: [], selected: new Set(), anchor: null, loading: false, error: null };
    this.term.write('\r\n');
    this.connect();
  }

  setMonitor(on) {
    if (this.status !== 'connected' || this.target.kind !== 'ssh' || this.monitorOn === on) return;
    this.monitorOn = on;
    this.control({ type: 'monitor', enabled: on });
  }

  close() {
    if (this.disposed) return;
    const index = [...tabs.keys()].indexOf(this.key);
    this.disposed = true;
    this.stopConnection();
    this.status = 'closed';
    this.connId = null;
    this.monitorOn = false;
    this.stats = null;
    cancelAnimationFrame(this.fitRaf);
    this.resizeObs?.disconnect();
    bus.emit('term-disposing', this);
    this.term?.dispose();
    this.tabEl.remove();
    this.paneEl.remove();
    tabs.delete(this.key);
    bus.emit('tab-closed', this);
    if (state.activeKey === this.key) {
      const rest = [...tabs.keys()];
      activate(rest[index] || rest[index - 1] || 'home');
    }
    bus.emit('tabs-changed');
  }
}

export function activate(key, { focusTerminal = true } = {}) {
  if (key !== 'home' && !tabs.has(key)) return;
  const prev = tabs.get(state.activeKey);
  state.activeKey = key;
  $$('#tabbar .tab').forEach((t) => {
    const selected = t.dataset.tab === key;
    t.classList.toggle('active', selected);
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
  });
  $$('#panes .pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-home' ? key === 'home' : p.dataset.tab === key));
  const tab = tabs.get(key);
  if (prev && prev !== tab) prev.setMonitor(false);
  if (tab) {
    tab.setMonitor(true);
    tab.scheduleFit();
    if (tab.term && focusTerminal) tab.term.focus();
    tab.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  bus.emit('active-changed', key);
}

bus.on('settings-changed', () => {
  for (const t of tabs.values()) t.applySettings();
});

bus.provide('all-tabs', () => [...tabs.values()]);
