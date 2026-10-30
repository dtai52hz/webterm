// Tìm từ khoá cần tô màu trong một dòng chữ (giống "syntax highlighting" của MobaXterm).
// Chỉ dùng danh sách từ cố định + mẫu IPv4 viết sẵn, không nhận regex do người dùng nhập.

export const KEYWORDS = {
  error: [
    'error', 'errors', 'err', 'fail', 'failed', 'failure', 'fatal', 'denied', 'refused', 'critical', 'panic', 'exception',
    'traceback', 'segfault', 'unreachable', 'killed', 'aborted', 'invalid', 'inactive', 'dead', 'stopped',
    'not found', 'no such file or directory', 'permission denied', 'connection refused', 'timed out',
  ],
  warn: ['warn', 'warning', 'warnings', 'deprecated', 'retry', 'retrying', 'notice', 'caution', 'skipped', 'skipping'],
  ok: [
    'ok', 'success', 'successful', 'successfully', 'succeeded', 'done', 'passed', 'active', 'running', 'enabled',
    'started', 'completed', 'complete', 'listening', 'online', 'ready', 'accepted',
  ],
};

const IPV4 = String.raw`(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?::\d{1,5})?`;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');

function group(words) {
  return [...words].sort((a, b) => b.length - a.length).map(escape).join('|');
}

// Khớp nguyên từ: ký tự liền trước/sau không được là chữ, số, gạch dưới (vd. "inactive" không khớp "active").
const B = '(?<![A-Za-z0-9_])';
const E = '(?![A-Za-z0-9_])';

export function buildMatcher(keywords = KEYWORDS) {
  const src = [
    `(?<error>${B}(?:${group(keywords.error)})${E})`,
    `(?<warn>${B}(?:${group(keywords.warn)})${E})`,
    `(?<ok>${B}(?:${group(keywords.ok)})${E})`,
    `(?<info>(?<![\\d.])${IPV4}(?![\\d.]))`,
  ].join('|');
  return new RegExp(src, 'gi');
}

const DEFAULT_MATCHER = buildMatcher();

// Trả về [{start, end, kind}] theo chỉ số ký tự trong chuỗi.
export function findMatches(text, matcher = DEFAULT_MATCHER) {
  const out = [];
  if (!text || !text.trim()) return out;
  matcher.lastIndex = 0;
  for (const m of text.matchAll(matcher)) {
    const kind = Object.keys(m.groups).find((k) => m.groups[k] !== undefined);
    out.push({ start: m.index, end: m.index + m[0].length, kind });
  }
  return out;
}
