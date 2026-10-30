'use strict';
// Chạy trong renderer qua executeJavaScript, chỉ ở chế độ --smoke (dữ liệu tạm).
module.exports = async function smokeUi() {
  const { state, tabs, bus } = await import('/js/state.js');
  const { api } = await import('/js/core/api.js');
  const { loadSessions } = await import('/js/sessions.js');
  const { activate, TermTab } = await import('/js/term/tab.js');
  const { reopenTab } = await import('/js/tab-history.js');
  const { showMenuAt } = await import('/js/core/menu.js');
  const { openEditor } = await import('/js/editor.js');
  const wait = async (test, label) => {
    const deadline = Date.now() + 8000;
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`UI: quá thời gian chờ ${label}`);
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  let checks = 0;
  const check = (ok, label) => { if (!ok) throw new Error(`UI: ${label}`); checks++; };
  const key = (node, name, options = {}) => node.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options }));
  const palette = document.querySelector('#dlg-commands');
  const input = document.querySelector('#command-input');
  const search = (query) => { input.value = query; input.dispatchEvent(new Event('input', { bubbles: true })); };
  await wait(() => state.ready, 'khởi động');

  key(document, 'k', { ctrlKey: true });
  check(palette.open && document.activeElement === input, 'Ctrl+K mở ô tìm kiếm');
  key(input, 'ArrowDown');
  const selected = input.getAttribute('aria-activedescendant');
  bus.emit('tabs-changed');
  check(input.getAttribute('aria-activedescendant') === selected, 'sự kiện nền giữ lựa chọn');
  search('cai dat');
  check(document.querySelector('#command-results .selected .command-name')?.textContent === 'Mở cài đặt', 'tìm không dấu');
  key(input, 'Enter');
  check(!palette.open && document.querySelector('#dlg-settings').open, 'Enter mở công cụ');
  key(document, 'k', { ctrlKey: true });
  check(!palette.open, 'không ngắt hộp thoại đang mở');
  document.querySelector('#dlg-settings').close();

  // Các menu dùng được chỉ bằng bàn phím và trả focus đúng nút đã mở menu.
  const tools = document.querySelector('#btn-tools');
  let menuAction = 0;
  const menuItems = [
    { label: 'Không khả dụng', disabled: true, action: () => { menuAction = -1; } },
    { label: 'Thao tác thứ nhất', action: () => { menuAction = 1; } },
    { label: 'Thao tác thứ hai', checked: false, action: () => { menuAction = 2; } },
  ];
  showMenuAt(tools, menuItems);
  const context = document.querySelector('#ctxmenu');
  check(document.activeElement.textContent.includes('Thao tác thứ nhất'), 'menu bỏ qua mục vô hiệu');
  key(document.activeElement, 'ArrowDown');
  check(document.activeElement.getAttribute('role') === 'menuitemcheckbox', 'menu mũi tên chuyển mục');
  key(document.activeElement, 'Enter');
  check(menuAction === 2 && context.hidden && document.activeElement === tools, 'menu Enter thực hiện và trả focus');
  showMenuAt(tools, menuItems);
  key(document.activeElement, 'Escape');
  check(context.hidden && document.activeElement === tools && tools.getAttribute('aria-expanded') === 'false', 'menu Escape đóng và trả focus');

  const session = await api('POST', '/api/sessions', { type: 'local', name: 'Máy chủ Đà Nẵng', folder: 'Khách hàng', shell: 'cmd' });
  try {
    await loadSessions();
    const row = document.querySelector(`#session-tree [data-id="${session.id}"]`);
    const edit = row.querySelector('button[aria-label="Sửa"]');
    key(edit, 'Enter');
    check(tabs.size === 0, 'Enter trên nút sửa không mở terminal');
    edit.click();
    check(document.querySelector('#dlg-session').open, 'nút sửa mở form session');
    document.querySelector('#dlg-session').close();
    const connect = row.querySelector('button.go');
    key(connect, 'Enter');
    connect.click();
    check(tabs.size === 1, 'Enter trên nút kết nối chỉ mở một tab');
    const tab = [...tabs.values()][0];
    tab.tabEl.focus();
    await wait(() => tab.status === 'connected', 'terminal local');
    check(document.activeElement === tab.tabEl, 'kết nối sẵn sàng không giành focus');
    key(tab.tabEl, 'ArrowLeft');
    const home = document.querySelector('#tab-home');
    check(state.activeKey === 'home' && document.activeElement === home, 'mũi tên trái chuyển tab bằng bàn phím');
    key(home, 'ArrowRight');
    check(state.activeKey === tab.key && document.activeElement === tab.tabEl && tab.tabEl.getAttribute('aria-selected') === 'true', 'mũi tên phải và trạng thái tab');
    check(document.querySelectorAll('#tabbar .tab[tabindex="0"]').length === 1, 'chỉ tab đang chọn nằm trong thứ tự Tab');
    activate('home');
    key(document, 'k', { ctrlKey: true });
    search('da nang');
    check(document.querySelectorAll('#command-results [role=option]').length === 2, 'tìm session và tab không dấu');
    key(input, 'Enter');
    check(state.activeKey === tab.key && !palette.open, 'chuyển tới tab đang mở');
    key(document, 'k', { ctrlKey: true });
    search('<img src=x onerror=alert(1)>');
    check(!document.querySelector('#command-results img') && !input.hasAttribute('aria-activedescendant'), 'kết quả rỗng và dữ liệu an toàn');
    key(input, 'Enter');
    check(palette.open, 'Enter khi không có kết quả');
    document.querySelector('#command-close').click();
    const middle = new TermTab({ kind: 'local', name: 'Terminal 2', shell: 'cmd', windowsPty: state.windowsPty });
    const last = new TermTab({ kind: 'local', name: 'Terminal 3', shell: 'cmd', windowsPty: state.windowsPty });
    activate(middle.key);
    middle.close();
    check(state.activeKey === last.key, 'đóng tab chọn tab liền kề');
    last.close();
    const oldConnection = tab.connId;
    tab.setName('Terminal đã đổi tên');
    tab.close();
    key(document, 'T', { ctrlKey: true, shiftKey: true });
    const restored = [...tabs.values()][0];
    check(tabs.size === 1 && restored.nameEl.textContent === 'Terminal đã đổi tên', 'mở lại tab bằng Ctrl+Shift+T giữ tên');
    await wait(() => restored.status === 'connected', 'mở lại terminal');
    check(restored.connId !== oldConnection, 'tab mở lại tạo kết nối mới');
    restored.close();
    check(reopenTab() !== null, 'mở lại tab từ API menu');
    for (const current of [...tabs.values()]) current.close();

    // Kiểm tra editor thật trong renderer với phản hồi lưu do test điều khiển.
    const originalFetch = window.fetch;
    const writes = [];
    window.fetch = (url, options) => {
      if (String(url) === '/api/sftp/ui-editor/read') return Promise.resolve(new Response(JSON.stringify({ content: 'original\r\n' })));
      if (String(url) === '/api/sftp/ui-editor/write') return new Promise((resolve) => writes.push({ body: JSON.parse(options.body), resolve }));
      return originalFetch(url, options);
    };
    try {
      await openEditor({ connId: 'ui-editor', disposed: false, sftp: { cwd: null } }, '/ui-smoke.txt');
      const text = document.querySelector('#editor-text');
      const saved = document.querySelector('#editor-save');
      const setText = (value) => { text.value = value; text.dispatchEvent(new Event('input', { bubbles: true })); };
      setText('first\n');
      const closing = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(closing);
      check(closing.defaultPrevented && bus.collect('unsaved-changes').length === 1, 'cảnh báo khi còn file chưa lưu');
      key(text, 's', { ctrlKey: true });
      key(text, 's', { ctrlKey: true });
      check(writes.length === 1 && saved.disabled && writes[0].body.content === 'first\r\n', 'chỉ một lần lưu và giữ CRLF');
      setText('second\n');
      writes[0].resolve(new Response(JSON.stringify({ ok: true })));
      await wait(() => !saved.disabled, 'lưu lần đầu');
      check(document.querySelector('#editor-state').textContent.includes('Chưa lưu'), 'gõ thêm trong khi lưu vẫn còn thay đổi');
      key(text, 's', { ctrlKey: true });
      writes[1].resolve(new Response(JSON.stringify({ ok: true })));
      await wait(() => !saved.disabled, 'lưu lần hai');
      check(bus.collect('unsaved-changes').length === 0 && writes[1].body.content === 'second\r\n', 'lưu đầy đủ nội dung mới');
      const clean = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(clean);
      check(!clean.defaultPrevented, 'không cảnh báo khi đã lưu và hết kết nối');
      document.querySelector('#editor-form button[value="close"]').click();
      await wait(() => !document.querySelector('#dlg-editor').open, 'đóng editor');
    } finally {
      window.fetch = originalFetch;
    }
    return { ok: true, checks };
  } finally {
    for (const tab of [...tabs.values()]) tab.close();
    if (palette.open) palette.close();
    await api('DELETE', `/api/sessions/${session.id}`);
    await loadSessions();
  }
};
