'use strict';
// Đọc/ghi file JSON an toàn: ghi ra file tạm rồi rename để không bao giờ để lại file ghi dở.
const fs = require('fs');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  // Trên Windows, antivirus đôi khi giữ file trong chốc lát (EPERM/EBUSY): thử lại vài lần.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        try {
          fs.unlinkSync(tmp);
        } catch {}
        throw e;
      }
      const until = Date.now() + 50 * (attempt + 1);
      while (Date.now() < until);
    }
  }
}

// Collection = mảng object có trường id, lưu trong một file.
function collection(file) {
  return {
    file,
    list: () => readJson(file, []),
    get: (id) => readJson(file, []).find((x) => x.id === id) || null,
    save: (items) => writeJson(file, items),
    insert(item) {
      const items = this.list();
      items.push(item);
      this.save(items);
      return item;
    },
    update(id, fn) {
      const items = this.list();
      const i = items.findIndex((x) => x.id === id);
      if (i < 0) return null;
      items[i] = fn(items[i]);
      this.save(items);
      return items[i];
    },
    remove(id) {
      const items = this.list();
      const next = items.filter((x) => x.id !== id);
      if (next.length === items.length) return false;
      this.save(next);
      return true;
    },
  };
}

module.exports = { readJson, writeJson, collection };
