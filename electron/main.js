'use strict';
// App desktop WebTerm: chạy server ngay trong tiến trình Electron (chỉ nghe 127.0.0.1)
// rồi mở giao diện trong một cửa sổ riêng, không cần trình duyệt hay lệnh npm.
const { app, BrowserWindow, Menu, shell, dialog, session, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const portable = require('./portable');

const SMOKE = process.argv.includes('--smoke');
const PREFERRED_PORT = 47321;
// Thư mục dữ liệu của WebTerm trên chính máy này (%APPDATA%\WebTerm), dùng khi không chạy từ USB.
const machineUserData = app.getPath('userData');

// Bản Portable chạy từ USB: mọi thứ (session, SSH key, cả cache của cửa sổ) nằm trong WebTerm-data cạnh file .exe,
// nên rút USB là mang theo hết và máy đang cắm gần như không giữ lại gì. WEBTERM_SMOKE_PORTABLE=1 để test chế độ này.
const usb = SMOKE && !process.env.WEBTERM_SMOKE_PORTABLE ? { root: null } : portable.setup();
if (usb.root) {
  app.setPath('userData', usb.root);
  app.setPath('sessionData', path.join(usb.root, 'browser'));
  app.setPath('crashDumps', path.join(usb.root, 'crashes'));
  process.env.WEBTERM_SSH_DIR = process.env.WEBTERM_SSH_DIR || path.join(usb.root, 'keys');
} else if (SMOKE) {
  // Chế độ --smoke dùng thư mục dữ liệu tạm để test không đụng tới dữ liệu thật.
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-smoke-')));
}

const userData = app.getPath('userData');
const configFile = path.join(userData, 'app.json');
process.env.WEBTERM_DATA = path.join(userData, 'data');
process.env.WEBTERM_TOKEN = crypto.randomBytes(24).toString('base64url');

// Server chỉ nạp sau khi đã hỏi có chép dữ liệu sang USB hay không: store.js đọc WEBTERM_DATA ngay lúc nạp.
let webterm = null;
let settings = null;

function loadServer() {
  webterm = require('../server');
  settings = require('../lib/settings');
  require('../lib/events').on('settings', applyTheme);
}

// Thanh tiêu đề liền với giao diện: màu nền và nút thu nhỏ/phóng to/đóng khớp với giao diện sáng/tối.
const CHROME = {
  dark: { bg: '#0b0e13', bar: { color: '#11151b', symbolColor: '#b6c0cc', height: 50 } },
  light: { bg: '#eef1f5', bar: { color: '#ffffff', symbolColor: '#3a4656', height: 50 } },
};

function applyTheme() {
  const pref = settings ? settings.get().uiTheme : 'system';
  nativeTheme.themeSource = pref === 'dark' || pref === 'light' ? pref : 'system';
  const c = CHROME[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(c.bg);
    if (process.platform === 'win32') win.setTitleBarOverlay(c.bar);
  }
  return c;
}

nativeTheme.on('updated', () => applyTheme());

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ ...readConfig(), ...patch }, null, 2));
  } catch {}
}

// Giữ cố định cổng giữa các lần mở để localStorage (session gần đây, cỡ chữ...) không bị mất.
async function startServer() {
  const saved = readConfig().port || PREFERRED_PORT;
  // App desktop luôn chạy trên chính máy người dùng: bật terminal local, RDP, editor ngoài, lưu key vào ~/.ssh.
  const opts = { host: '127.0.0.1', quiet: true, localFeatures: true, portableDir: usb.root };
  try {
    return await webterm.start({ ...opts, port: saved });
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    const started = await webterm.start({ ...opts, port: 0 });
    writeConfig({ port: started.port });
    return started;
  }
}

// Lần đầu chạy từ USB trên máy đã có dữ liệu WebTerm: hỏi có chép sang USB để mang theo không.
function offerCopyToUsb() {
  const from = path.join(machineUserData, 'data');
  if (!portable.hasData(from)) return;
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Chép sang USB', 'Bắt đầu trống'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'WebTerm',
    message: 'Chép session của máy này sang USB?',
    detail:
      `Session, mật khẩu đã lưu, macro, tunnel và cài đặt sẽ được chép vào ${usb.root}.\n\n` +
      'File SSH key không được chép. Muốn mang theo thì chép file key vào thư mục "keys" trong đó, rồi ghi tên file vào session.\n\n' +
      'Nên bật master password (Cài đặt → Bảo mật) để mất USB không lộ mật khẩu.',
  });
  if (choice !== 0) return;
  try {
    portable.copyData(from, path.join(usb.root, 'data'));
  } catch (e) {
    dialog.showErrorBox('WebTerm', `Không chép được dữ liệu sang USB: ${e.message}`);
  }
}

let win = null;

function createWindow({ origin, link }) {
  const cfg = readConfig();
  const bounds = cfg.bounds || {};
  const chrome = applyTheme();
  win = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 800,
    x: bounds.x,
    y: bounds.y,
    minWidth: 720,
    minHeight: 480,
    title: 'WebTerm',
    backgroundColor: chrome.bg,
    icon: path.join(__dirname, 'icon.png'),
    // Ẩn thanh tiêu đề mặc định; thanh trên cùng của giao diện đóng vai trò thanh tiêu đề (kéo được).
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: chrome.bar } : {}),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Cửa sổ test ẩn vẫn cần vẽ frame và chạy ResizeObserver như cửa sổ đang mở.
      ...(SMOKE ? { backgroundThrottling: false } : {}),
    },
  });
  if (cfg.maximized) win.maximize();
  if (!SMOKE) win.once('ready-to-show', () => win.show());

  const wc = win.webContents;
  const sameApp = (url) => url === origin || url.startsWith(origin + '/');
  const openOutside = (url) => /^https?:\/\//i.test(url) && shell.openExternal(url);

  // Link trong terminal mở bằng trình duyệt mặc định; cửa sổ app không bao giờ rời khỏi WebTerm.
  wc.setWindowOpenHandler(({ url }) => {
    if (!sameApp(url)) openOutside(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (sameApp(url)) return;
    e.preventDefault();
    openOutside(url);
  });

  // Trang chặn đóng khi còn phiên SSH (beforeunload); Electron không tự hỏi nên ta hỏi.
  wc.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Thoát', 'Ở lại'],
      defaultId: 1,
      cancelId: 1,
      title: 'WebTerm',
      message: 'Còn phiên đang mở hoặc thay đổi chưa lưu',
      detail: 'Thoát sẽ ngắt kết nối và bỏ những thay đổi chưa lưu. Bạn chắc chắn muốn thoát?',
    });
    if (choice === 0) e.preventDefault();
  });

  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    } else if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      wc.toggleDevTools();
      e.preventDefault();
    }
  });

  win.on('close', () => {
    writeConfig({ maximized: win.isMaximized(), bounds: win.isMaximized() ? cfg.bounds : win.getBounds() });
  });
  win.on('closed', () => (win = null));

  if (SMOKE) wc.once('did-finish-load', () => runSmoke(wc));
  win.loadURL(link);
}

// Kiểm tra nhanh app đóng gói: giao diện nạp được, API có cookie, và (nếu có) SSH chạy được trong Electron.
async function runSmoke(wc) {
  const sshTarget = process.env.WEBTERM_SMOKE_SSH || '';
  const timer = setTimeout(() => finish({ error: 'timeout' }, 2), 40_000);
  function finish(result, code) {
    clearTimeout(timer);
    const out = JSON.stringify({ electron: process.versions.electron, ...result });
    if (process.env.WEBTERM_SMOKE_OUT) fs.writeFileSync(process.env.WEBTERM_SMOKE_OUT, out);
    console.log('SMOKE ' + out);
    app.exit(code);
  }
  try {
    const ui = await wc.executeJavaScript(`(${require('./smoke-ui').toString()})()`);
    const result = await wc.executeJavaScript(`(async () => {
      const caps = await (await fetch('/api/capabilities')).json();
      const r = { title: document.title, xterm: typeof Terminal, fit: typeof FitAddon, search: typeof SearchAddon, api: (await fetch('/api/sessions')).status, localFeatures: caps.localFeatures, portable: caps.portable };
      // Terminal local qua node-pty (kiểm tra module native nạp được từ thư mục đã unpack khỏi asar).
      r.local = await new Promise((resolve) => {
        const ws = new WebSocket('ws://' + location.host + '/ws/term');
        ws.binaryType = 'arraybuffer';
        let out = '';
        const t = setTimeout(() => resolve({ ok: false, out: out.slice(-200) }), 15000);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'connect', kind: 'local', shell: 'cmd', cols: 80, rows: 24 }));
        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') {
            out += new TextDecoder().decode(ev.data);
            if (out.includes('smoke-local-ok')) { clearTimeout(t); ws.close(); resolve({ ok: true }); }
            return;
          }
          const m = JSON.parse(ev.data);
          if (m.type === 'ready') setTimeout(() => ws.send(new TextEncoder().encode('echo smoke-local-%OS:~0,0%ok\\r')), 500);
          if (m.type === 'error') { clearTimeout(t); resolve({ ok: false, error: m.message }); }
        };
      });
      const target = ${JSON.stringify(sshTarget)};
      if (target) {
        const [host, port] = target.split(':');
        r.ssh = await new Promise((resolve) => {
          const ws = new WebSocket('ws://' + location.host + '/ws/term');
          ws.binaryType = 'arraybuffer';
          let out = '';
          const t = setTimeout(() => resolve({ ok: false, out }), 15000);
          ws.onopen = () => ws.send(JSON.stringify({ type: 'connect', host, port: Number(port), username: 'test', password: 'secret', cols: 80, rows: 24 }));
          ws.onmessage = (ev) => {
            if (typeof ev.data !== 'string') {
              out += new TextDecoder().decode(ev.data);
              if (/whoami\\r\\ntest\\r\\n/.test(out)) { clearTimeout(t); ws.close(); resolve({ ok: true }); }
              return;
            }
            const m = JSON.parse(ev.data);
            if (m.type === 'ask' && m.kind === 'hostkey') ws.send(JSON.stringify({ type: 'answer', id: m.id, accept: true }));
            if (m.type === 'ready') setTimeout(() => ws.send(new TextEncoder().encode('whoami\\r')), 300);
            if (m.type === 'error') { clearTimeout(t); resolve({ ok: false, error: m.message }); }
          };
        });
      }
      return r;
    })()`);
    result.ui = ui;
    const ok = ui.ok && result.api === 200 && result.xterm === 'function' && result.fit === 'object' && result.search === 'object' && result.localFeatures && result.local.ok && (!sshTarget || result.ssh.ok);
    // Tuỳ chọn: chụp ảnh cửa sổ để kiểm tra giao diện bản desktop.
    if (process.env.WEBTERM_SMOKE_SHOT) {
      try {
        if (process.env.WEBTERM_SMOKE_SHOT_COMMANDS === '1') {
          await wc.executeJavaScript(`(async () => {
            const style = document.createElement('style');
            style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
            document.head.append(style);
            (await import('/js/commands.js')).openCommands();
          })()`);
          // Chờ frame kế tiếp để dialog đã bố trí xong trước khi chụp.
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const img = await wc.capturePage(undefined, { stayHidden: true });
        fs.writeFileSync(process.env.WEBTERM_SMOKE_SHOT, img.toPNG());
      } catch {}
    }
    finish(result, ok ? 0 : 1);
  } catch (e) {
    finish({ error: e.message }, 1);
  }
}

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    // Bỏ menu mặc định để Ctrl+W, Ctrl+R, Ctrl+N... đi thẳng vào terminal thay vì đóng/tải lại cửa sổ.
    Menu.setApplicationMenu(null);
    // Chỉ cho phép quyền clipboard (copy khi bôi đen, dán bằng chuột phải).
    const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write']);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

    if (usb.error && !SMOKE) {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: 'WebTerm',
        message: 'Không ghi được dữ liệu vào USB',
        detail: `${usb.error}\n\nLần này session và cài đặt được lưu trên máy: ${machineUserData}`,
      });
    }
    if (usb.firstRun && !SMOKE) offerCopyToUsb();

    try {
      loadServer();
      createWindow(await startServer());
    } catch (e) {
      dialog.showErrorBox('WebTerm', `Không khởi động được server nội bộ: ${e.message}`);
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => app.quit());
}
