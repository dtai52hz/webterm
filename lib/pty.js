'use strict';
// Mở terminal local bằng node-pty (ConPTY trên Windows 10/11).
const fs = require('fs');
const os = require('os');
const shells = require('./shells');
const { cleanEnv } = require('./guard');

const MAX_PTYS = 20;
let open = 0;
let ptyModule = null;

function loadPty() {
  if (!ptyModule) {
    try {
      ptyModule = require('node-pty');
    } catch (e) {
      throw new Error(`Không nạp được node-pty: ${e.message}`);
    }
  }
  return ptyModule;
}

function spawnShell(shellId, { cols = 80, rows = 24, cwd } = {}) {
  const shell = shells.get(shellId) || shells.list()[0];
  if (!shell) throw new Error('Không tìm thấy shell nào trên máy này');
  if (open >= MAX_PTYS) throw new Error(`Đã mở tối đa ${MAX_PTYS} terminal local`);
  let dir = os.homedir();
  try {
    if (cwd && fs.statSync(cwd).isDirectory()) dir = cwd;
  } catch {}
  const p = loadPty().spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: dir,
    env: cleanEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }),
    useConpty: true,
  });
  open++;
  let counted = true;
  p.onExit(() => {
    if (counted) open--;
    counted = false;
  });
  return { pty: p, shell };
}

// Số build Windows (vd. 26200) để xterm.js xử lý đúng việc reflow với ConPTY.
function windowsBuild() {
  if (process.platform !== 'win32') return 0;
  return Number(os.release().split('.')[2]) || 0;
}

module.exports = { spawnShell, windowsBuild };
