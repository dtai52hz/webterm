'use strict';
// Cài đặt giao diện terminal, lưu ở server để không mất khi đổi cổng/trình duyệt.
const { dataPath } = require('./datadir');
const { readJson, writeJson } = require('./jsonstore');
const events = require('./events');

const FILE = dataPath('settings.json');
const THEMES = ['webterm', 'mobaxterm', 'solarizedDark', 'solarizedLight', 'dracula', 'monokai', 'oneLight'];
const CURSORS = ['block', 'bar', 'underline'];

const UI_THEMES = ['system', 'dark', 'light'];

const DEFAULTS = {
  uiTheme: 'system',
  theme: 'webterm',
  fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'DejaVu Sans Mono', monospace",
  fontSize: 14,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: true,
  rightClickPaste: true,
  highlight: true,
  externalEditor: '',
};

const clampInt = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};

function validate(input, base = DEFAULTS) {
  const s = { ...base };
  if ('uiTheme' in input) s.uiTheme = UI_THEMES.includes(input.uiTheme) ? input.uiTheme : base.uiTheme;
  if ('theme' in input) s.theme = THEMES.includes(input.theme) ? input.theme : base.theme;
  if ('fontFamily' in input) s.fontFamily = String(input.fontFamily || '').replace(/[;{}<>]/g, '').trim().slice(0, 200) || DEFAULTS.fontFamily;
  if ('fontSize' in input) s.fontSize = clampInt(input.fontSize, 9, 28, base.fontSize);
  if ('cursorStyle' in input) s.cursorStyle = CURSORS.includes(input.cursorStyle) ? input.cursorStyle : base.cursorStyle;
  if ('scrollback' in input) s.scrollback = clampInt(input.scrollback, 500, 100000, base.scrollback);
  for (const k of ['cursorBlink', 'copyOnSelect', 'rightClickPaste', 'highlight']) if (k in input) s[k] = Boolean(input[k]);
  if ('externalEditor' in input) {
    const p = String(input.externalEditor || '').trim().slice(0, 1024);
    if (p && process.platform === 'win32' && !/\.exe$/i.test(p)) {
      throw Object.assign(new Error('Editor ngoài phải là file .exe'), { status: 400 });
    }
    s.externalEditor = p;
  }
  return s;
}

function get() {
  return validate(readJson(FILE, {}));
}

function update(patch) {
  const next = validate(patch || {}, get());
  writeJson(FILE, next);
  events.emit('settings', next);
  return next;
}

function replaceAll(all) {
  writeJson(FILE, validate(all || {}));
}

module.exports = { DEFAULTS, THEMES, get, update, replaceAll, validate };
