// Bộ icon SVG dạng nét (24×24, nét 2px), dùng thống nhất cho toàn bộ giao diện thay cho emoji.
const FILE = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>';
const FOLDER = '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>';
const TRAY = '<path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>';

const P = {
  logo: '<path d="M6.5 9l3.5 3-3.5 3"/><path d="M12.5 15.5h5"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7.5 9.5l3 2.5-3 2.5"/><path d="M12.5 15h4"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  'server-plus': '<rect x="3" y="4" width="13" height="7" rx="2"/><rect x="3" y="13" width="13" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01M19.5 7v6M16.5 10h6"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  usb: '<rect x="6.5" y="9" width="11" height="13" rx="2.5"/><path d="M9 9V3h6v6"/><path d="M11 6h.01M13 6h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  'chevron-up': '<path d="M6 15l6-6 6 6"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  'arrow-up': '<path d="M12 19V5M6 11l6-6 6 6"/>',
  'corner-up': '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/>',
  home: '<path d="M4 11.5L12 4l8 7.5"/><path d="M6 10v9.5a.5.5 0 0 0 .5.5H10v-6h4v6h3.5a.5.5 0 0 0 .5-.5V10"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4.5V11h-6.5"/>',
  folder: FOLDER,
  'folder-plus': FOLDER + '<path d="M12 10.5v6M9 13.5h6"/>',
  'folder-up': FOLDER + '<path d="M12 16.5v-6M9.5 13l2.5-2.5 2.5 2.5"/>',
  file: FILE,
  'file-plus': FILE + '<path d="M12 11.5v6M9 14.5h6"/>',
  'file-text': FILE + '<path d="M9 13h6M9 17h4"/>',
  'file-code': FILE + '<path d="M10 12.5l-2 2.25 2 2.25M14 12.5l2 2.25-2 2.25"/>',
  'file-image': FILE + '<circle cx="10" cy="12.5" r="1.25"/><path d="M19 16.5l-3-3L9 20.5"/>',
  'file-archive': FILE + '<path d="M10 3v2M10 7v2M10 11v2M10 15h.01"/>',
  'file-cog': FILE + '<circle cx="12" cy="15" r="2"/><path d="M12 11.5v1.5M12 17v1.5M8.5 15H10M14 15h1.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  upload: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5"/>' + TRAY,
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/>' + TRAY,
  import: '<path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M15 3h3.5A2.5 2.5 0 0 1 21 5.5v13a2.5 2.5 0 0 1-2.5 2.5H15"/>',
  save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7.5 3v5h8"/><path d="M7.5 21v-6.5h9V21"/>',
  restore: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v5h5"/><path d="M12 8v4.5l3 2"/>',
  settings: '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 4v16"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M12 4v16"/>',
  rows: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 12h18"/>',
  grid: '<rect x="3" y="3.5" width="7.5" height="7.5" rx="1.75"/><rect x="13.5" y="3.5" width="7.5" height="7.5" rx="1.75"/><rect x="3" y="13" width="7.5" height="7.5" rx="1.75"/><rect x="13.5" y="13" width="7.5" height="7.5" rx="1.75"/>',
  square: '<rect x="3" y="4" width="18" height="16" rx="2.5"/>',
  broadcast: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
  tunnel: '<path d="M8 3.5L4 7.5l4 4"/><path d="M4 7.5h16"/><path d="M16 20.5l4-4-4-4"/><path d="M20 16.5H4"/>',
  tools:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"/>',
  zap: '<path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12z"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  record: '<circle cx="12" cy="12" r="6"/>',
  edit: '<path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/><path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
  copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="2"/><path d="M5.5 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5"/>',
  duplicate: '<rect x="8" y="8" width="12.5" height="12.5" rx="2"/><path d="M4 16V5.5A1.5 1.5 0 0 1 5.5 4H16"/><path d="M14.25 11.5v6M11.25 14.5h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4.5-4.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 7.6-1.75"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L20.5 2.5M16.5 6.5l3 3M14 9l2 2"/>',
  shield: '<path d="M12 3l8 3v6c0 4.97-3.4 8.15-8 9-4.6-.85-8-4.03-8-9V6z"/>',
  'shield-check': '<path d="M12 3l8 3v6c0 4.97-3.4 8.15-8 9-4.6-.85-8-4.03-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.7 8.5 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  note: '<path d="M6 3h9l4 4v12.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6 3z"/><path d="M9 11h6M9 15h4"/>',
  jump: '<path d="M15 10l5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  memory: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 10.5v3M11 10.5v3M15 10.5v3M7 17v3M17 17v3M7 4v3M17 4v3"/>',
  disk: '<path d="M4.5 13.5l2.4-7.2A2 2 0 0 1 8.8 5h6.4a2 2 0 0 1 1.9 1.3l2.4 7.2"/><rect x="3" y="13.5" width="18" height="6.5" rx="2"/><path d="M7 17h.01M11 17h.01"/>',
  network: '<path d="M7 4v13M3.5 13.5L7 17l3.5-3.5"/><path d="M17 20V7M13.5 10.5L17 7l3.5 3.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/>',
  alert: '<path d="M10.3 4.2L2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a7 7 0 0 0 10.8 10.8z"/>',
  more: '<circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17.5 10h.01M7.5 14h9"/>',
  mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v3.5"/>',
  hash: '<path d="M5 9h15M4 15h15M10 3.5L8 20.5M16 3.5l-2 17"/>',
};

// Các icon được tô đặc thay vì vẽ nét.
const FILLED = new Set(['play', 'record', 'more']);

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', ['ic', FILLED.has(name) ? 'ic-fill' : '', cls].filter(Boolean).join(' '));
  svg.innerHTML = P[name] || P.file;
  return svg;
}

// Thay mọi <i data-icon="..."> trong HTML tĩnh bằng SVG tương ứng.
export function hydrateIcons(root = document) {
  for (const n of root.querySelectorAll('i[data-icon]')) n.replaceWith(icon(n.dataset.icon, n.className));
}

// Icon + màu theo loại file trên server (thư mục, mã nguồn, ảnh, nén...).
const EXT = [
  [/\.(zip|tar|gz|tgz|bz2|xz|zst|7z|rar|deb|rpm|apk|jar|war|iso)$/i, 'file-archive', 'archive'],
  [/\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i, 'file-image', 'image'],
  [/\.(js|mjs|cjs|ts|tsx|jsx|py|php|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|sh|bash|zsh|fish|ps1|sql|html?|css|scss|vue|lua|pl)$/i, 'file-code', 'code'],
  [/\.(json|ya?ml|toml|ini|conf|cfg|env|xml|service|properties)$|^\.?(env|htaccess|gitignore|dockerfile|makefile|nginx\.conf)$/i, 'file-cog', 'config'],
  [/\.(txt|md|log|csv|rst|out|err)$|^(readme|license|changelog)/i, 'file-text', 'text'],
];

export function fileIcon(entry) {
  if (entry.type === 'd' || entry.target === 'd') return { name: 'folder', kind: 'dir' };
  if (entry.type === 'l') return { name: 'link', kind: 'link' };
  for (const [re, name, kind] of EXT) if (re.test(entry.name)) return { name, kind };
  return { name: 'file', kind: 'file' };
}
