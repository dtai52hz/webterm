'use strict';
// Chạy toàn bộ test: unit test giao diện (node --test) rồi lần lượt từng file test end-to-end.
// Dùng: npm test            (tất cả)
//       npm test -- sftp    (chỉ file có tên chứa "sftp")
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const filter = process.argv[2];
const E2E = ['smoke.js', 'terminal.js', 'ssh.js', 'sftp.js', 'local.js', 'vault.js'].filter((f) => fs.existsSync(path.join(__dirname, f)));
const UNIT = fs.readdirSync(path.join(__dirname, 'unit')).filter((f) => f.endsWith('.test.mjs') || f.endsWith('.test.js'));

const results = [];
function run(label, args) {
  if (filter && !label.includes(filter)) return;
  const started = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  results.push({ label, ok: r.status === 0, secs: ((Date.now() - started) / 1000).toFixed(1) });
}

run('unit', ['--test', ...UNIT.map((f) => path.join('test', 'unit', f))]);
for (const f of E2E) run(f, [path.join('test', f)]);

console.log('\n=== Tổng kết ===');
for (const r of results) console.log(`${r.ok ? '✓' : '✖'} ${r.label} (${r.secs}s)`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} nhóm test LỖI.` : `\nTất cả ${results.length} nhóm test đều đạt.`);
process.exitCode = failed.length ? 1 : 0;
