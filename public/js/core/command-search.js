// Tìm kiếm không dấu; mọi từ phải xuất hiện trong tên hoặc thông tin của mục.
export function normalizeSearch(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

export function searchCommands(commands, query) {
  const q = normalizeSearch(query).trim();
  if (!q) return [...commands];
  const words = q.split(/\s+/);
  return commands
    .map((command, index) => {
      const label = normalizeSearch(command.label);
      const haystack = normalizeSearch([command.label, command.detail, command.keywords, command.group].join(' '));
      const score = label === q ? 0 : label.startsWith(q) ? 1 : label.includes(q) ? 2 : 3;
      return { command, index, score, matches: words.every((word) => haystack.includes(word)) };
    })
    .filter((item) => item.matches)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((item) => item.command);
}
