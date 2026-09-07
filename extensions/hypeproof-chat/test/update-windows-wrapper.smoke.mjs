import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderWindowsUpdateWrapper } from '../src/updateCheckerHelpers.ts';

if (process.platform !== 'win32') {
  console.log('NOT RUN: Windows PowerShell wrapper execution requires the Windows CI runner');
} else {
  const root = mkdtempSync(join(tmpdir(), 'hps-update-'));
  try {
    for (const running of [false, true]) {
      const script = join(root, `wrapper-${running}.ps1`);
      const output = join(root, `result-${running}.json`);
      const installerPath = join(root, "한글 사용자's app", 'Setup.exe');
      // Keep the actual wrapper control flow/encoding; mock OS process lookup and
      // the installer launch so CI never installs or closes a real application.
      const prelude = `\uFEFFfunction Get-Process { param($Name, $ErrorAction) ${running ? "return @{Name='Studio'}" : 'return $null'} }\r\nfunction Start-Sleep {}\r\nfunction Start-Process { param($FilePath, $ArgumentList) @{path=$FilePath;args=$ArgumentList} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $env:HPS_UPDATE_TEST_OUTPUT }\r\n`;
      const wrapper = renderWindowsUpdateWrapper({ appProcessName: 'Studio', installerPath, installerArgs: ['/silent', '/mergetasks=runcode', '/LOG="C:\\한글 사용자\\update.log"'], maxWaitMs: 0 });
      writeFileSync(script, prelude + wrapper.slice(1), 'utf8');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { env: { ...process.env, HPS_UPDATE_TEST_OUTPUT: output }, encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, running ? 1 : 0, result.stderr);
      if (!running) assert.equal(JSON.parse(readFileSync(output, 'utf8').replace(/^\uFEFF/, '')).path, installerPath);
      else assert.throws(() => readFileSync(output), { code: 'ENOENT' });
      console.log(`PASS Windows PowerShell wrapper: running=${running}; no actual installer launched`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
