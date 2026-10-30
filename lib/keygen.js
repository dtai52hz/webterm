'use strict';
// Tạo SSH key (giống MobaKeyGen) và chép public key lên server (giống ssh-copy-id).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const posix = path.posix;
const { utils } = require('ssh2');
const { call, httpError } = require('./sftp');
const { sshDir } = require('./keypath');

const TYPES = { ed25519: {}, rsa: { bits: 4096 } };
const PUBKEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/;

function fingerprintOf(publicKey) {
  const parsed = utils.parseKey(publicKey);
  if (parsed instanceof Error) throw httpError(400, 'Public key không hợp lệ');
  return 'SHA256:' + crypto.createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
}

// Bản bất đồng bộ: tạo RSA 4096 có thể mất vài giây, không được làm treo app.
function generate({ type = 'ed25519', comment = '', passphrase = '' } = {}) {
  if (!TYPES[type]) throw httpError(400, 'Loại key không hỗ trợ');
  const opts = { ...TYPES[type], comment: String(comment).replace(/[\r\n]/g, ' ').slice(0, 200) };
  if (passphrase) Object.assign(opts, { passphrase, cipher: 'aes256-ctr' });
  return new Promise((resolve, reject) =>
    utils.generateKeyPair(type, opts, (err, keys) => {
      if (err) return reject(err);
      const publicKey = keys.public.trim();
      resolve({ privateKey: keys.private, publicKey, fingerprint: fingerprintOf(publicKey), type });
    })
  );
}

// Lưu vào ~/.ssh (chạy từ USB: WebTerm-data\keys); cờ "wx" để không bao giờ ghi đè key đã có.
function save(name, { privateKey, publicKey }) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name || '') || name.startsWith('.')) throw httpError(400, 'Tên file key chỉ gồm chữ, số, dấu chấm, gạch ngang, gạch dưới');
  const dir = sshDir();
  fs.mkdirSync(dir, { recursive: true });
  const priv = path.join(dir, name);
  const pub = `${priv}.pub`;
  try {
    fs.writeFileSync(priv, privateKey, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code === 'EEXIST') throw httpError(409, `File ${priv} đã tồn tại, hãy đặt tên khác`);
    throw e;
  }
  fs.writeFileSync(pub, publicKey + '\n', { flag: 'wx', mode: 0o644 });
  return { privatePath: priv, publicPath: pub };
}

function checkPublicKey(publicKey) {
  const k = String(publicKey || '').trim();
  if (!PUBKEY_RE.test(k)) throw httpError(400, 'Public key không hợp lệ');
  return k;
}

const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// Giống ssh-copy-id: tạo ~/.ssh (700), thêm key nếu chưa có (tự thêm xuống dòng trước), chmod 600, restorecon nếu có.
function installScript(publicKey) {
  return [
    '# webterm-install-key',
    `KEY=${shQuote(publicKey)}`,
    'umask 077',
    'mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" || { echo "webterm-key error mkdir"; exit 0; }',
    'f="$HOME/.ssh/authorized_keys"',
    'set -- $KEY; blob=$2',
    'if [ -f "$f" ] && grep -qF "$blob" "$f"; then',
    '  echo "webterm-key exists"',
    'else',
    '  if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then echo >> "$f"; fi',
    '  printf \'%s\\n\' "$KEY" >> "$f" && echo "webterm-key installed"',
    'fi',
    'chmod 600 "$f"',
    'command -v restorecon >/dev/null 2>&1 && restorecon -R "$HOME/.ssh" >/dev/null 2>&1',
    'exit 0',
  ].join('\n') + '\n';
}

// Dự phòng khi server không cho chạy lệnh (chỉ có SFTP).
async function installViaSftp(sftp, publicKey) {
  const home = await call((cb) => sftp.realpath('.', cb));
  const dir = posix.join(home, '.ssh');
  const file = posix.join(dir, 'authorized_keys');
  try {
    await call((cb) => sftp.mkdir(dir, { mode: 0o700 }, cb));
  } catch {}
  let cur = '';
  try {
    cur = await new Promise((resolve, reject) => {
      let s = '';
      sftp.createReadStream(file).on('data', (d) => (s += d)).on('end', () => resolve(s)).on('error', reject);
    });
  } catch {}
  const blob = publicKey.split(/\s+/)[1];
  if (cur.split(/\r?\n/).some((l) => l.split(/\s+/)[1] === blob)) return 'exists';
  const next = cur + (cur && !cur.endsWith('\n') ? '\n' : '') + publicKey + '\n';
  await new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(file, { mode: 0o600 });
    ws.on('error', reject);
    ws.on('close', resolve);
    ws.end(next);
  });
  await call((cb) => sftp.chmod(file, 0o600, cb)).catch(() => {});
  await call((cb) => sftp.chmod(dir, 0o700, cb)).catch(() => {});
  return 'installed';
}

async function install(conn, publicKey) {
  const key = checkPublicKey(publicKey);
  const out = await conn.execScript(installScript(key));
  const m = out && out.match(/webterm-key (installed|exists|error)/);
  if (m && m[1] !== 'error') return { status: m[1], via: 'shell' };
  const status = await installViaSftp(await conn.getSftp(), key);
  return { status, via: 'sftp' };
}

module.exports = { generate, save, install, installScript, fingerprintOf, checkPublicKey };
