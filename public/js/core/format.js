// Định dạng số liệu và xử lý đường dẫn POSIX phía server.
export const fmtBytes = (n) => {
  if (n == null || Number.isNaN(n)) return '–';
  if (n < 1024) return `${Math.round(n)} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
};

export const fmtDate = (t) => (t ? new Date(t * 1000).toLocaleString('vi-VN') : '');

export const fmtUptime = (s) => {
  if (s == null) return '–';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}n ${h}g` : h ? `${h}g ${m}p` : `${m}p`;
};

export const joinPath = (dir, name) => (name.startsWith('/') ? name : dir.endsWith('/') ? dir + name : `${dir}/${name}`);

export const parentPath = (p) => {
  const t = p.replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  return i <= 0 ? '/' : t.slice(0, i);
};

export const baseName = (p) => p.replace(/\/+$/, '').split('/').pop();

export const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

export const targetLabel = (u, host, port, defPort = 22) =>
  `${u ? u + '@' : ''}${host}${port && Number(port) !== defPort ? ':' + port : ''}`;
