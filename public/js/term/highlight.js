// Tô màu từ khoá trong terminal bằng decoration của xterm.js (không sửa luồng dữ liệu từ server).
import { bus, tabs } from '../state.js';
import { prefs } from '../prefs.js';
import { themeOf } from './themes.js';
import { findMatches } from './highlight-core.js';

const MAX_DECOS = 1500;
const MAX_LINES_PER_PASS = 500;

class Highlighter {
  constructor(tab) {
    this.term = tab.term;
    this.records = []; // {marker, x, width, kind, deco}
    this.scanMarker = null;
    this.timer = null;
    this.cell = null;
    this.subs = [
      this.term.onWriteParsed(() => this.schedule()),
      this.term.buffer.onBufferChange((buf) => this.onBufferChange(buf)),
      this.term.onResize(() => this.reset(true)),
    ];
  }

  schedule() {
    if (this.timer || !prefs().highlight) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scan();
    }, 30);
  }

  color(kind) {
    return themeOf(prefs().theme).hl[kind];
  }

  // Dòng y (tuyệt đối trong buffer) → chữ và bảng ánh xạ chỉ số ký tự → cột.
  readLine(buf, y) {
    const line = buf.getLine(y);
    if (!line) return null;
    if (!this.cell) this.cell = buf.getNullCell();
    let text = '';
    const cols = [];
    const defFg = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x, this.cell);
      if (!cell) break;
      const w = cell.getWidth();
      if (w === 0) continue; // nửa sau của ký tự rộng
      const ch = cell.getChars() || ' ';
      for (let k = 0; k < ch.length; k++) {
        cols.push(x);
        defFg.push(cell.isFgDefault());
      }
      text += ch;
    }
    return { text, cols, defFg, width: line.length };
  }

  scanLine(buf, y) {
    const info = this.readLine(buf, y);
    if (!info) return;
    for (const m of findMatches(info.text)) {
      // Không đè màu do chương trình tự tô (vd. ls --color).
      let allDefault = true;
      for (let i = m.start; i < m.end; i++) if (!info.defFg[i]) allDefault = false;
      if (!allDefault) continue;
      const x = info.cols[m.start];
      const last = info.cols[m.end - 1];
      const lastCell = buf.getLine(y).getCell(last, this.cell);
      const width = last - x + (lastCell ? Math.max(1, lastCell.getWidth()) : 1);
      const marker = this.term.registerMarker(y - (buf.baseY + buf.cursorY));
      if (!marker) continue;
      const rec = { marker, x, width, kind: m.kind, deco: null };
      this.attach(rec);
      this.records.push(rec);
      marker.onDispose(() => {
        const i = this.records.indexOf(rec);
        if (i >= 0) this.records.splice(i, 1);
      });
    }
  }

  attach(rec) {
    if (rec.marker.isDisposed) return;
    rec.deco = this.term.registerDecoration({ marker: rec.marker, x: rec.x, width: rec.width, foregroundColor: this.color(rec.kind) }) || null;
  }

  scan() {
    if (!prefs().highlight) return;
    const buf = this.term.buffer.active;
    if (buf.type !== 'normal') return;
    const cursorLine = buf.baseY + buf.cursorY;
    let start = this.scanMarker && !this.scanMarker.isDisposed ? this.scanMarker.line : Math.max(0, cursorLine - this.term.rows);
    if (start < 0) start = Math.max(0, cursorLine - this.term.rows);
    if (cursorLine - start > MAX_LINES_PER_PASS) start = cursorLine - MAX_LINES_PER_PASS;
    // Dòng con trỏ lần trước có thể chưa xong: xoá decoration từ dòng đó rồi quét lại.
    for (const rec of [...this.records]) if (rec.marker.line >= start) this.disposeRec(rec);
    for (let y = start; y <= cursorLine; y++) this.scanLine(buf, y);
    if (this.scanMarker) this.scanMarker.dispose();
    this.scanMarker = this.term.registerMarker(0);
    while (this.records.length > MAX_DECOS) this.disposeRec(this.records[0]);
  }

  disposeRec(rec) {
    if (rec.deco) rec.deco.dispose();
    rec.marker.dispose();
    const i = this.records.indexOf(rec);
    if (i >= 0) this.records.splice(i, 1);
  }

  // Vào màn hình phụ (vim, htop...): gỡ decoration để không lem màu sang; quay lại thì gắn lại.
  onBufferChange(buf) {
    if (buf.type === 'alternate') {
      for (const rec of this.records) {
        if (rec.deco) rec.deco.dispose();
        rec.deco = null;
      }
    } else {
      for (const rec of this.records) if (!rec.deco) this.attach(rec);
      this.schedule();
    }
  }

  // Đổi theme, tắt/bật, hoặc resize (reflow làm lệch cột): xoá hết và quét lại vùng đang hiển thị.
  reset(rescan) {
    for (const rec of [...this.records]) this.disposeRec(rec);
    if (this.scanMarker) this.scanMarker.dispose();
    this.scanMarker = null;
    if (rescan && prefs().highlight && this.term.buffer.active.type === 'normal') {
      const buf = this.term.buffer.active;
      const top = buf.viewportY;
      const cursorLine = buf.baseY + buf.cursorY;
      for (let y = top; y <= cursorLine; y++) this.scanLine(buf, y);
      this.scanMarker = this.term.registerMarker(0);
    }
  }

  dispose() {
    clearTimeout(this.timer);
    this.subs.forEach((s) => s.dispose());
    this.reset(false);
  }
}

const byTab = new Map();

bus.on('term-created', (tab) => byTab.set(tab.key, new Highlighter(tab)));
bus.on('term-disposing', (tab) => {
  const h = byTab.get(tab.key);
  if (h) h.dispose();
  byTab.delete(tab.key);
});
bus.on('settings-changed', () => {
  for (const [key, h] of byTab) if (tabs.has(key)) h.reset(true);
});
