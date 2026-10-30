'use strict';
// Theo dõi tài nguyên server từ xa (giống thanh "remote monitoring" của MobaXterm).
// Script được gửi vào stdin của `sh -s` (không phụ thuộc login shell là bash, zsh hay fish),
// rồi phân tích kết quả đọc từ /proc.

const SCRIPT = [
  '# webterm-monitor',
  'export LC_ALL=C',
  'echo "load $(cut -d" " -f1-3 /proc/loadavg)"',
  'head -n1 /proc/stat',
  "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
  'echo "disk $(df -Pk / | tail -n1 | awk \'{print $2, $3}\')"',
  'echo "up $(cut -d" " -f1 /proc/uptime)"',
  'awk \'NR>2{gsub(":"," "); if ($1!="lo") {rx+=$2; tx+=$10}} END{print "net", rx+0, tx+0}\' /proc/net/dev',
].join('\n') + '\n';

function parse(output) {
  const out = {};
  for (const line of output.split('\n')) {
    const p = line.trim().split(/\s+/);
    switch (p[0]) {
      case 'load':
        out.load = p.slice(1, 4).map(Number);
        break;
      case 'cpu': {
        const nums = p.slice(1).map(Number);
        out.cpuTotal = nums.reduce((a, b) => a + b, 0);
        out.cpuIdle = (nums[3] || 0) + (nums[4] || 0);
        break;
      }
      case 'MemTotal:':
        out.memTotal = Number(p[1]) * 1024;
        break;
      case 'MemAvailable:':
        out.memAvailable = Number(p[1]) * 1024;
        break;
      case 'disk':
        out.diskTotal = Number(p[1]) * 1024;
        out.diskUsed = Number(p[2]) * 1024;
        break;
      case 'up':
        out.uptime = Number(p[1]);
        break;
      case 'net':
        out.rx = Number(p[1]);
        out.tx = Number(p[2]);
        break;
    }
  }
  if (out.cpuTotal === undefined || out.memTotal === undefined) return null;
  return out;
}

// prev: mẫu lần trước, dùng để tính % CPU và tốc độ mạng.
function summarize(sample, prev, elapsedSec) {
  const s = {
    load: sample.load,
    memTotal: sample.memTotal,
    memUsed: sample.memTotal - (sample.memAvailable ?? 0),
    diskTotal: sample.diskTotal,
    diskUsed: sample.diskUsed,
    uptime: sample.uptime,
    cpu: null,
    rxRate: null,
    txRate: null,
  };
  if (prev) {
    const dt = sample.cpuTotal - prev.cpuTotal;
    const di = sample.cpuIdle - prev.cpuIdle;
    if (dt > 0) s.cpu = Math.max(0, Math.min(100, (1 - di / dt) * 100));
    if (elapsedSec > 0 && sample.rx !== undefined && prev.rx !== undefined) {
      s.rxRate = Math.max(0, (sample.rx - prev.rx) / elapsedSec);
      s.txRate = Math.max(0, (sample.tx - prev.tx) / elapsedSec);
    }
  }
  return s;
}

module.exports = { SCRIPT, parse, summarize };
