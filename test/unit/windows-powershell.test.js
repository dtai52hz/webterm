'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { POWERSHELL, powerShellEnv } = require('../../lib/windows-powershell');
const { dpapiBlob, runPowerShell } = require('../../lib/rdp');

test('Windows PowerShell: bỏ đường dẫn module kế thừa và biến nội bộ khỏi process con', () => {
  const saved = { PSModulePath: process.env.PSModulePath, WEBTERM_TOKEN: process.env.WEBTERM_TOKEN };
  try {
    process.env.PSModulePath = 'modules-cua-powershell-khac';
    process.env.WEBTERM_TOKEN = 'khong-truyen-sang-process-con';
    const env = powerShellEnv();
    assert.ok(!Object.keys(env).some((key) => /^PSModulePath$/i.test(key)));
    assert.ok(!Object.keys(env).some((key) => /^WEBTERM_/i.test(key)));
    assert.strictEqual(process.env.PSModulePath, 'modules-cua-powershell-khac', 'không sửa môi trường của app');
    assert.ok(POWERSHELL.endsWith('powershell.exe'));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Windows PowerShell: DPAPI và Archive vẫn hoạt động khi app thừa hưởng module không tương thích', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-psmodules-'));
  const saved = process.env.PSModulePath;
  try {
    for (const [name, commands] of [
      ['Microsoft.PowerShell.Security', ['ConvertTo-SecureString', 'ConvertFrom-SecureString']],
      ['Microsoft.PowerShell.Archive', ['Expand-Archive']],
    ]) {
      const moduleDir = path.join(dir, name);
      fs.mkdirSync(moduleDir);
      fs.writeFileSync(path.join(moduleDir, `${name}.psd1`), `@{ ModuleVersion = '1.0'; PowerShellVersion = '99.0'; CmdletsToExport = @(${commands.map((c) => `'${c}'`).join(', ')}) }`);
    }
    process.env.PSModulePath = dir;
    const blob = await dpapiBlob('Mật-khẩu#123');
    const encoded = Buffer.from('Mật-khẩu#123', 'utf8').toString('base64');
    const result = await runPowerShell(`$ErrorActionPreference = 'Stop'\n$s = ConvertTo-SecureString '${blob}'\n$p = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))\nif ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p)) -ne '${encoded}') { exit 1 }\n(Get-Command Expand-Archive -ErrorAction Stop).ModuleName`);
    assert.strictEqual(result, 'Microsoft.PowerShell.Archive');
  } finally {
    if (saved === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
