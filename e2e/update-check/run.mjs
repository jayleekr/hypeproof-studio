// Read-only update UI check. Never clicks install or changes the installed app.
import { _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const data = mkdtempSync(join(tmpdir(), 'hps-update-ui-'));
const report = resolve(root, 'e2e/test-results/update-check');
const appPath = join(data, 'HypeProof Studio.app');
mkdirSync(join(data, 'User'), { recursive: true });
mkdirSync(join(data, 'workspace'));
mkdirSync(report, { recursive: true });
writeFileSync(join(data, 'User/settings.json'), JSON.stringify({
  'hypeproofChat.proxyUrl': 'http://127.0.0.1:1/v1',
  'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
}));
let app;
try {
  // A development-extension launch can silently use the bundled old extension
  // if engine compatibility rejects the override. Inject only into a scratch
  // copy, then assert byte equality, so this run exercises the changed host.
  execFileSync('/usr/bin/ditto', [process.env.HPS_UPDATE_APP_PATH || '/Applications/HypeProof Studio.app', appPath]);
  const source = join(root, 'extensions/hypeproof-chat/dist/extension.js');
  const injected = join(appPath, 'Contents/Resources/app/extensions/hypeproof-chat/dist/extension.js');
  copyFileSync(source, injected);
  assert.deepEqual(readFileSync(injected), readFileSync(source));
  execFileSync('/usr/bin/ditto', [join(root, 'extensions/hypeproof-chat/webview-ui/dist'), join(appPath, 'Contents/Resources/app/extensions/hypeproof-chat/webview-ui/dist')]);
  app = await electron.launch({
    executablePath: join(appPath, 'Contents/MacOS/HypeProof Studio'),
    args: [`--user-data-dir=${data}`, `--extensions-dir=${join(data, 'extensions')}`, '--use-inmemory-secretstorage', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--folder-uri', pathToFileURL(join(data, 'workspace')).href],
    timeout: 30_000,
  });
  await app.evaluate(({ app: a, BrowserWindow }) => { a.dock?.hide(); for (const w of BrowserWindow.getAllWindows()) w.setPosition(-4000, -4000); });
  const win = await app.firstWindow();
  await win.waitForSelector('.monaco-workbench');
  await win.keyboard.press('Escape');
  await win.keyboard.press('Meta+Shift+P');
  const input = win.locator('.quick-input-widget input.input').first();
  await input.fill('>HypeProof Chat: 업데이트 확인');
  await win.waitForTimeout(300);
  await win.keyboard.press('Enter');
  const message = win.locator('.notifications-toasts').getByText(/새 버전 v.*발견|최신 버전입니다/);
  try {
    await message.waitFor({ timeout: 30_000 });
  } catch (error) {
    await win.screenshot({ path: join(report, 'update-check-failed.png') });
    console.error(await win.locator('.notifications-toasts').innerText());
    throw error;
  }
  console.log('PASS real Electron update command:', await message.innerText());
  if (/새 버전/.test(await message.innerText())) {
    await win.keyboard.press('Escape');
    await win.locator('.monaco-workbench .part.titlebar').first().click({ position: { x: 10, y: 10 }, force: true });
    await win.keyboard.press('Meta+Shift+P');
    await input.fill('>HypeProof Chat: Focus');
    await win.waitForTimeout(300);
    await win.keyboard.press('Enter');
    const chat = win.frameLocator('iframe.webview.ready[src*="purpose=webviewView"]').first().frameLocator('#active-frame');
    try {
      await chat.locator('.hps-update-banner').waitFor({ timeout: 30_000 });
    } catch (error) {
      await win.screenshot({ path: join(report, 'update-banner-failed.png') });
      console.error('frames:', win.frames().map(f => f.url()));
      throw error;
    }
    await win.keyboard.press('Escape');
    await win.screenshot({ path: join(report, 'update-banner.png') });
    await chat.locator('.hps-update-banner-dismiss').click();
    await chat.locator('.hps-update-banner').waitFor({ state: 'hidden' });
    console.log('PASS real Electron update banner: visible, Later dismisses it without installation');
  }
  await win.screenshot({ path: join(report, 'update-check.png') });
  console.log('NOT RUN: install/restart; this check never replaces the installed app.');
} finally {
  if (app) await app.close();
  rmSync(data, { recursive: true, force: true });
}
