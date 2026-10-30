'use strict';
// Dò thư mục hiện tại của shell trong tab (tính năng "SFTP theo terminal" của MobaXterm).
// Script chạy qua `sh -s` trên CÙNG kết nối SSH với shell, nên đi ngược PPid từ $$ sẽ gặp đúng tiến trình sshd
// xử lý kết nối này. Con của nó có stdin là /dev/pts/* chính là shell tương tác; sau đó xuống tới shell con sâu nhất
// còn đọc được (vd. sau `su`/`sudo -i` khi đăng nhập root).
// Bảng pid→ppid được đọc một lần bằng `read` dựng sẵn của sh (không tạo tiến trình con cho từng pid).
const SCRIPT = [
  '# webterm-probe',
  'map=""',
  'for d in /proc/[0-9]*; do',
  '  while read -r k v _; do',
  '    if [ "$k" = "PPid:" ]; then map="$map ${d#/proc/}:$v"; break; fi',
  '  done 2>/dev/null < "$d/status"',
  'done',
  'ppid_of() { for e in $map; do case "$e" in "$1":*) echo "${e#*:}"; return;; esac; done; }',
  'children_of() { for e in $map; do case "$e" in *":$1") echo "${e%%:*}";; esac; done; }',
  'comm_of() { c=""; read -r c 2>/dev/null < "/proc/$1/comm"; echo "$c"; }',
  'p=$$; s=""',
  'while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do',
  '  case "$(comm_of "$p")" in sshd*|dropbear*) s=$p; break;; esac',
  '  p=$(ppid_of "$p")',
  'done',
  'if [ -z "$s" ]; then echo "cwd-none no-sshd"; exit 0; fi',
  'shell=""',
  'for c in $(children_of "$s"); do',
  '  [ "$c" = "$$" ] && continue',
  '  case "$(readlink "/proc/$c/fd/0" 2>/dev/null)" in /dev/pts/*) shell=$c;; esac',
  'done',
  'if [ -z "$shell" ]; then echo "cwd-none no-shell"; exit 0; fi',
  'best=$shell; cur=$shell; depth=0',
  'while [ "$depth" -lt 4 ]; do',
  '  next=""',
  '  for c in $(children_of "$cur"); do',
  '    case "$(comm_of "$c")" in',
  '      bash|sh|zsh|fish|dash|ksh|ash|mksh|tcsh|csh) next=$c; (cd "/proc/$c/cwd" 2>/dev/null) && best=$c;;',
  '      sudo|su|login|doas) next=$c;;',
  '    esac',
  '  done',
  '  [ -z "$next" ] && break',
  '  cur=$next; depth=$((depth+1))',
  'done',
  'cwd=$(cd "/proc/$best/cwd" 2>/dev/null && pwd -P)',
  'if [ -n "$cwd" ]; then echo "cwd $cwd"; else echo "cwd-none unreadable"; fi',
].join('\n') + '\n';

// Lấy dòng "cwd ..." trong output (có thể lẫn với output của script giám sát).
function parse(output) {
  if (!output) return null;
  const m = output.match(/^cwd (\/.*)$/m);
  if (m) return { path: m[1].trim() };
  const none = output.match(/^cwd-none (.*)$/m);
  return none ? { none: none[1].trim() } : null;
}

module.exports = { SCRIPT, parse };
