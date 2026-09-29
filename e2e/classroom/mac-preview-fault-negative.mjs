// #751 U4 — negative control for the test-only preview fault (HPS_TEST_PREVIEW_FAULT). The SAME prepared Studio copy that
// mac-recovery.mjs drives is started WITHOUT that variable; the learner's preview is opened in a real window and the very file
// the positive run uses as its trigger is created. The preview server must keep answering on the same address and the tab
// must stay where it was: in a normal launch nothing watches for that file.
//
//   HPS_DEVHOST_DIR=e2e/test-results/classroom-devhost-u4 node --experimental-strip-types --no-warnings e2e/classroom/mac-preview-fault-negative.mjs
//
// Own debug port (9442), own user-data dir and HOME; it closes the copy it started. It does not touch the U4 recovery run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { macWindow } from './mac-window.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), home = path.resolve(process.env.HPS_DEVHOST_DIR || path.join(repo, 'e2e/test-results/classroom-devhost-u4'));
const debugPort = Number(process.env.HPS_U4_NEGATIVE_DEBUG_PORT || 9442), sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const manifest = JSON.parse(readFileSync(path.join(home, 'manifest.json'), 'utf8')), copy = path.join(home, 'HypeProof Studio (ops devhost).app'), ext = path.join(copy, 'Contents/Resources/app/extensions/hypeproof-chat');
for (const [f, h] of Object.entries(manifest.extension.bundles)) assert.equal(sha(path.join(ext, f)), h, `${f} changed since prepare`);
const userDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hps-751-u4n-'))), ws = path.join(userDir, 'ws'), fakeHome = path.join(userDir, 'home'); for (const d of [path.join(userDir, 'User'), ws, fakeHome]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(ws, 'page.html'), '<!doctype html><title>학생 결과물</title><h1>SYNTHETIC LEARNER PAGE U4 NEGATIVE</h1>\n');
writeFileSync(path.join(userDir, 'User/settings.json'), JSON.stringify({ 'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off' }));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(API_KEY|AUTH_TOKEN|SIGNING_SECRET|ADMIN_PASSWORD|_SECRET$|HPS_TEST|ELECTRON_RUN_AS_NODE)/.test(k)));
assert.equal(env.HPS_TEST_PREVIEW_FAULT, undefined, 'the control launch must not carry the fault variable');
const app = spawn(path.join(copy, 'Contents/MacOS/HypeProof Studio'), ['--user-data-dir=' + userDir, '--extensions-dir=' + path.join(userDir, 'extensions'), '--use-inmemory-secretstorage', '--disable-workspace-trust', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--remote-debugging-port=' + debugPort, '--new-window', ws], { env: { ...env, HOME: fakeHome }, stdio: ['ignore', 'ignore', 'ignore'] });
const realFetch = globalThis.fetch, W = macWindow({ debugPort, realFetch, out: home }), { sleep, wait, attach, palette } = W;
try {
  const win = await attach();
  await win.bringToFront(); await win.keyboard.press('Meta+P'); await win.waitForSelector('.quick-input-widget input', { state: 'visible' }); await win.keyboard.type('page.html', { delay: 15 }); await sleep(1200); await win.keyboard.press('Enter'); await sleep(1500);
  await palette(win, 'HypeProof: HTML 미리보기 (옆 패널)');
  const tabs = async () => (await (await realFetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).filter((t) => /^http:\/\/127\.0\.0\.1:\d+\/page\.html/.test(t.url));
  const tab = await wait(async () => (await tabs())[0], 'the preview tab is open'); assert.match(await (await realFetch(tab.url)).text(), /SYNTHETIC LEARNER PAGE U4 NEGATIVE/);
  const trigger = path.join(userDir, 'drop-preview-server'); writeFileSync(trigger, ''); await sleep(4000);
  const still = await (await realFetch(tab.url, { signal: AbortSignal.timeout(3000) })).text(); assert.match(still, /SYNTHETIC LEARNER PAGE U4 NEGATIVE/, 'the preview server still answers on the same address');
  const after = await tabs(); assert.deepEqual(after.map((t) => [t.id, t.url]), [[tab.id, tab.url]], 'the tab did not move');
  assert.ok(existsSync(trigger), 'nothing consumed the trigger file');
  const result = { schema: 'hps-classroom-preview-fault-negative/1', at: new Date().toISOString(), source_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), extension_source_sha: manifest.extension.source_sha, launch_env_has_fault_variable: false, trigger_file_created: true, trigger_file_consumed: false, preview_address_unchanged: true, preview_still_answers: true, tab_moved: false };
  writeFileSync(path.join(home, 'preview-fault-negative.json'), JSON.stringify(result, null, 2)); console.log('PASS — without HPS_TEST_PREVIEW_FAULT the trigger file does nothing: ' + JSON.stringify(result));
} finally { try { app.kill(); } catch {} }
process.exit(0);
