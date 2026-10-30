'use strict';
// Ghi file ZIP dạng stream (không cần biết trước kích thước file nén), hỗ trợ ZIP64 cho file/khối dữ liệu lớn.
// Mỗi file: local header (bit 3 = có data descriptor, bit 11 = tên UTF-8) → dữ liệu deflate → data descriptor.
const zlib = require('zlib');
const { once } = require('events');
const { pipeline } = require('stream/promises');

const ZIP64_FILE_THRESHOLD = 2 * 1024 ** 3; // file từ 2 GiB trở lên dùng ZIP64 (chừa chỗ cho file đang lớn dần)
const U32 = 0xffffffff;
const COMPRESSED_EXT = /\.(zip|gz|tgz|bz2|xz|zst|7z|rar|jpe?g|png|gif|webp|mp4|mkv|mov|avi|mp3|ogg|flac|woff2?|jar|apk|deb|rpm)$/i;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 =
  typeof zlib.crc32 === 'function'
    ? (buf, prev = 0) => zlib.crc32(buf, prev)
    : (buf, prev = 0) => {
        let c = (prev ^ U32) >>> 0;
        for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ U32) >>> 0;
      };

function dosDateTime(mtimeSec) {
  const d = new Date((mtimeSec || Date.now() / 1000) * 1000);
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// Tên trong zip: dùng '/', bỏ '..' và ký tự Windows không cho phép, tránh tên thiết bị (CON, NUL...).
function sanitizeName(name) {
  return String(name)
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => {
      let s = seg.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
      if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`;
      return s;
    })
    .join('/');
}

function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

class ZipWriter {
  // out: Writable (HTTP response). forceZip64: dùng ZIP64 cho mọi thứ (để test).
  constructor(out, { forceZip64 = false } = {}) {
    this.out = out;
    this.offset = 0;
    this.entries = [];
    this.forceZip64 = forceZip64;
    this.aborted = false;
    out.on('close', () => (this.aborted = true));
  }

  async write(buf) {
    if (this.aborted) throw Object.assign(new Error('Người dùng đã huỷ tải'), { code: 'aborted' });
    this.offset += buf.length;
    if (!this.out.write(buf)) await Promise.race([once(this.out, 'drain'), once(this.out, 'close')]);
  }

  localHeader(name, { method, zip64, mtime, dir }) {
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(mtime);
    const ut = Buffer.alloc(9);
    ut.writeUInt16LE(0x5455, 0); // extended timestamp (UTC)
    ut.writeUInt16LE(5, 2);
    ut.writeUInt8(1, 4);
    ut.writeUInt32LE(Math.max(0, Math.floor(mtime || 0)) >>> 0, 5);
    let extra = ut;
    if (zip64) {
      const z = Buffer.alloc(20);
      z.writeUInt16LE(0x0001, 0);
      z.writeUInt16LE(16, 2); // kích thước gốc và nén (0 vì có data descriptor)
      extra = Buffer.concat([z, ut]);
    }
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(zip64 ? 45 : 20, 4);
    h.writeUInt16LE(dir ? 0x0800 : 0x0808, 6); // bit 11 UTF-8, bit 3 data descriptor
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(0, 14);
    h.writeUInt32LE(zip64 ? U32 : 0, 18);
    h.writeUInt32LE(zip64 ? U32 : 0, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(extra.length, 28);
    return Buffer.concat([h, nameBuf, extra]);
  }

  async addDir(name, { mtime, mode = 0o755 } = {}) {
    const n = sanitizeName(name).replace(/\/?$/, '/');
    if (n === '/') return;
    const zip64 = this.forceZip64;
    const offset = this.offset;
    await this.write(this.localHeader(n, { method: 0, zip64, mtime, dir: true }));
    this.entries.push({ name: n, method: 0, crc: 0, csize: 0, usize: 0, offset, mtime, mode: 0o40000 | (mode & 0o7777), dir: true, zip64, hasDescriptor: false });
  }

  // source: Readable. size: kích thước biết trước (để quyết định ZIP64).
  async addFile(name, source, { size = 0, mtime, mode = 0o644 } = {}) {
    const n = sanitizeName(name);
    const zip64 = this.forceZip64 || size >= ZIP64_FILE_THRESHOLD;
    const offset = this.offset;
    await this.write(this.localHeader(n, { method: 8, zip64, mtime }));
    let crc = 0;
    let usize = 0;
    let csize = 0;
    const deflate = zlib.createDeflateRaw({ level: COMPRESSED_EXT.test(n) ? 1 : 6 });
    const self = this;
    await pipeline(
      source,
      async function* (chunks) {
        for await (const c of chunks) {
          crc = crc32(c, crc);
          usize += c.length;
          yield c;
        }
      },
      deflate,
      async function (chunks) {
        for await (const c of chunks) {
          csize += c.length;
          await self.write(c);
        }
      }
    );
    const dd = zip64 ? Buffer.alloc(24) : Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc >>> 0, 4);
    if (zip64) {
      dd.writeBigUInt64LE(BigInt(csize), 8);
      dd.writeBigUInt64LE(BigInt(usize), 16);
    } else {
      if (csize > U32 || usize > U32) throw new Error(`File ${n} lớn hơn dự kiến trong lúc nén`);
      dd.writeUInt32LE(csize, 8);
      dd.writeUInt32LE(usize, 12);
    }
    await this.write(dd);
    this.entries.push({ name: n, method: 8, crc: crc >>> 0, csize, usize, offset, mtime, mode: 0o100000 | (mode & 0o7777), dir: false, zip64 });
    return { size: usize };
  }

  async addText(name, text) {
    const { Readable } = require('stream');
    return this.addFile(name, Readable.from([Buffer.from(text, 'utf8')]), { size: Buffer.byteLength(text), mtime: Date.now() / 1000 });
  }

  centralHeader(e) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const { time, date } = dosDateTime(e.mtime);
    const needUsize = e.zip64 || e.usize > U32;
    const needCsize = e.zip64 || e.csize > U32;
    const needOffset = this.forceZip64 || e.offset > U32;
    const z = [];
    if (needUsize) z.push(u64(e.usize));
    if (needCsize) z.push(u64(e.csize));
    if (needOffset) z.push(u64(e.offset));
    const ut = Buffer.alloc(9);
    ut.writeUInt16LE(0x5455, 0);
    ut.writeUInt16LE(5, 2);
    ut.writeUInt8(1, 4);
    ut.writeUInt32LE(Math.max(0, Math.floor(e.mtime || 0)) >>> 0, 5);
    let extra = ut;
    if (z.length) {
      const zh = Buffer.alloc(4);
      zh.writeUInt16LE(0x0001, 0);
      zh.writeUInt16LE(z.length * 8, 2);
      extra = Buffer.concat([zh, ...z, ut]);
    }
    const zip64 = z.length > 0;
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE((3 << 8) | (zip64 ? 45 : 20), 4); // tạo bởi Unix (giữ quyền file)
    h.writeUInt16LE(zip64 ? 45 : 20, 6);
    h.writeUInt16LE(e.dir ? 0x0800 : 0x0808, 8);
    h.writeUInt16LE(e.method, 10);
    h.writeUInt16LE(time, 12);
    h.writeUInt16LE(date, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(needCsize ? U32 : e.csize, 20);
    h.writeUInt32LE(needUsize ? U32 : e.usize, 24);
    h.writeUInt16LE(nameBuf.length, 28);
    h.writeUInt16LE(extra.length, 30);
    h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34);
    h.writeUInt16LE(0, 36);
    h.writeUInt32LE(((e.mode << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38);
    h.writeUInt32LE(needOffset ? U32 : e.offset, 42);
    return Buffer.concat([h, nameBuf, extra]);
  }

  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) await this.write(this.centralHeader(e));
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    const zip64 = this.forceZip64 || count > 0xffff || cdStart > U32 || cdSize > U32;
    if (zip64) {
      const recOffset = this.offset;
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(0x06064b50, 0);
      rec.writeBigUInt64LE(44n, 4);
      rec.writeUInt16LE((3 << 8) | 45, 12);
      rec.writeUInt16LE(45, 14);
      rec.writeUInt32LE(0, 16);
      rec.writeUInt32LE(0, 20);
      rec.writeBigUInt64LE(BigInt(count), 24);
      rec.writeBigUInt64LE(BigInt(count), 32);
      rec.writeBigUInt64LE(BigInt(cdSize), 40);
      rec.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(recOffset), 8);
      loc.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([rec, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(zip64 ? 0xffff : count, 8);
    end.writeUInt16LE(zip64 ? 0xffff : count, 10);
    end.writeUInt32LE(zip64 ? U32 : cdSize, 12);
    end.writeUInt32LE(zip64 ? U32 : cdStart, 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
    this.out.end();
  }
}

module.exports = { ZipWriter, sanitizeName, crc32 };
