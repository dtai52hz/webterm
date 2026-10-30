'use strict';
const path = require('path');
const { cleanEnv } = require('./guard');

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function powerShellEnv() {
  const env = cleanEnv();
  // PowerShell 7 có thể truyền đường dẫn module không tương thích cho Windows PowerShell.
  // Để powershell.exe tự dựng lại đường dẫn mặc định cho đúng phiên bản của nó.
  for (const key of Object.keys(env)) if (/^PSModulePath$/i.test(key)) delete env[key];
  return env;
}

module.exports = { POWERSHELL, powerShellEnv };
