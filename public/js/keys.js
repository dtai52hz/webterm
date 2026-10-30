// Chuỗi phím <-> dạng có thể đọc và sửa trong textarea (\r, \n, \t, \e, \xHH, \\).
export function escapeKeys(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\x1b') out += '\\e';
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out;
}

export function unescapeKeys(s) {
  return s.replace(/\\(\\|r|n|t|e|x([0-9a-fA-F]{2}))/g, (_, k, hex) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return { '\\': '\\', r: '\r', n: '\n', t: '\t', e: '\x1b' }[k];
  });
}
