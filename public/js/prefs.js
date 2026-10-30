// Cài đặt hiện hành (lấy từ server, ghép với giá trị mặc định).
import { state } from './state.js';

export const DEFAULT_SETTINGS = {
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

export const prefs = () => ({ ...DEFAULT_SETTINGS, ...(state.settings || {}) });
