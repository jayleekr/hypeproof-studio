import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderInstallerScript } from '../src/updateCheckerHelpers.ts';

if (process.platform !== 'darwin') {
  console.log('NOT RUN: macOS installer execution requires macOS and PlistBuddy');
} else {
  const root = mkdtempSync(join(tmpdir(), 'hps-installer-'));
  try {
    for (const scenario of ['success', 'running', 'backup-fails', 'install-fails', 'stage-fails', 'wrong-bundle']) {
      const dir = join(root, scenario);
      const bin = join(dir, 'bin');
      mkdirSync(bin, { recursive: true });
      const oldAppPath = join(dir, "Studio 한글 ' $test.app");
      const newAppPath = join(dir, 'download.app');
      for (const [app, marker] of [[oldAppPath, 'old'], [newAppPath, 'new']]) {
        mkdirSync(join(app, 'Contents'), { recursive: true });
        const id = scenario === 'wrong-bundle' && marker === 'new' ? 'wrong.id' : 'ai.hypeproof.studio';
        writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`);
        writeFileSync(join(app, 'marker'), marker);
      }
      const commands = {
        pgrep: '[ "$SCENARIO" = running ]',
        sleep: 'exit 0',
        open: 'printf "%s\\n" "$1" >> "$OPEN_LOG"',
        xattr: 'exit 0',
        ditto: '[ "$SCENARIO" != stage-fails ] || exit 1\nexec /usr/bin/ditto "$@"',
        mv: '[ "$SCENARIO" != backup-fails ] || [ "$1" != "$OLD_TARGET" ] || exit 1\nif [ "$SCENARIO" = install-fails ]; then case "$1" in */next.app) exit 1;; esac; fi\nexec /bin/mv "$@"',
      };
      for (const [name, body] of Object.entries(commands)) writeFileSync(join(bin, name), '#!/bin/bash\n' + body + '\n', { mode: 0o755 });
      const script = join(dir, 'installer.sh');
      writeFileSync(script, renderInstallerScript({ newAppPath, oldAppPath, expectedBundleId: 'ai.hypeproof.studio', newVersion: '0.1.51', oldVersion: '0.1.50', logPath: join(dir, 'update.log') }));
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SCENARIO: scenario, OLD_TARGET: oldAppPath, OPEN_LOG: join(dir, 'open.log') };
      const run = spawnSync('/bin/bash', [script], { env, encoding: 'utf8', timeout: 10_000 });
      assert.equal(run.status, scenario === 'success' ? 0 : 1, readFileSync(join(dir, 'update.log'), 'utf8'));
      assert.equal(readFileSync(join(oldAppPath, 'marker'), 'utf8'), scenario === 'success' ? 'new' : 'old', scenario);
      if (scenario === 'success') {
        const stage = readdirSync(dir).find(n => n.startsWith('.hps-update.'));
        assert.equal(readFileSync(join(dir, stage, 'previous.app', 'marker'), 'utf8'), 'old');
        assert.ok(existsSync(env.OPEN_LOG));
      }
      if (scenario === 'running') assert.equal(existsSync(env.OPEN_LOG), false);
      console.log(`PASS real bash installer fixture: ${scenario}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
