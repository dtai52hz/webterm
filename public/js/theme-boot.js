// Chạy trước khi trang hiển thị (script thường, không phải module): đặt giao diện sáng/tối ngay
// để không bị nháy màu, và đánh dấu khi chạy trong app desktop (Electron).
(function () {
  var pref = 'system';
  try {
    pref = JSON.parse(localStorage.getItem('wt.uiTheme')) || 'system';
  } catch (e) {}
  var dark = pref === 'dark' || (pref !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  if (/Electron\//.test(navigator.userAgent)) root.classList.add('desktop');
})();
