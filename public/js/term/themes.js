// Bảng màu terminal. `hl` là màu dùng để tô từ khoá (lỗi/cảnh báo/thành công/thông tin) hợp với nền.
const DARK_HL = { error: '#ff6b6b', warn: '#f2c94c', ok: '#4cd97b', info: '#6cb6ff' };
const LIGHT_HL = { error: '#c62828', warn: '#9a6700', ok: '#1a7f37', info: '#0b5cad' };

export const THEMES = {
  webterm: {
    label: 'WebTerm Dark',
    hl: DARK_HL,
    theme: {
      background: '#0a0e13', foreground: '#d6dde6', cursor: '#3b9eff', cursorAccent: '#0a0e13', selectionBackground: 'rgba(59,158,255,0.35)',
      black: '#1b222c', red: '#f85149', green: '#3fb950', yellow: '#d29922', blue: '#3b9eff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#c9d1d9',
      brightBlack: '#6e7681', brightRed: '#ff7b72', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    },
  },
  mobaxterm: {
    label: 'MobaXterm cổ điển',
    hl: DARK_HL,
    theme: {
      background: '#000000', foreground: '#e8e8e8', cursor: '#e8e8e8', cursorAccent: '#000000', selectionBackground: 'rgba(255,255,255,0.3)',
      black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
      brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff',
    },
  },
  solarizedDark: {
    label: 'Solarized Dark',
    hl: { error: '#ff6e64', warn: '#e0b030', ok: '#a6c000', info: '#4fa8e8' },
    theme: {
      background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: 'rgba(147,161,161,0.25)',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#93a1a1', brightYellow: '#839496', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  solarizedLight: {
    label: 'Solarized Light',
    hl: LIGHT_HL,
    theme: {
      background: '#fdf6e3', foreground: '#586e75', cursor: '#586e75', cursorAccent: '#fdf6e3', selectionBackground: 'rgba(88,110,117,0.2)',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  dracula: {
    label: 'Dracula',
    hl: { error: '#ff6e6e', warn: '#f1fa8c', ok: '#50fa7b', info: '#8be9fd' },
    theme: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: 'rgba(98,114,164,0.5)',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  monokai: {
    label: 'Monokai',
    hl: { error: '#ff4f8a', warn: '#e6db74', ok: '#a6e22e', info: '#66d9ef' },
    theme: {
      background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', cursorAccent: '#272822', selectionBackground: 'rgba(73,72,62,0.8)',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
  },
  oneLight: {
    label: 'One Light',
    hl: LIGHT_HL,
    theme: {
      background: '#fafafa', foreground: '#383a42', cursor: '#526fff', cursorAccent: '#fafafa', selectionBackground: 'rgba(56,58,66,0.15)',
      black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401', blue: '#4078f2', magenta: '#a626a4', cyan: '#0184bc', white: '#a0a1a7',
      brightBlack: '#4f525e', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
  },
};

export const themeOf = (name) => THEMES[name] || THEMES.webterm;
