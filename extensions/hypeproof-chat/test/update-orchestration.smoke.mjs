import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { resolve } from 'node:path';

// Exercise the actual host orchestrator, replacing only the VS Code module.
const bundle = await build({
  entryPoints: [resolve('src/updateChecker.ts')], bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{ name: 'vscode-test-host', setup(b) {
    b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {}', loader: 'js' }));
  } }],
});
const mod = new Module(resolve('test/update-host.cjs'));
mod.filename = resolve('test/update-host.cjs');
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, mod.filename);
const { checkForUpdates, scheduleUpdateChecks } = mod.exports;
const originalFetch = globalThis.fetch;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
const release = {
  tag_name: 'v0.1.51', html_url: 'https://github.com/jayleekr/hypeproof-studio-releases/releases/tag/v0.1.51',
  assets: [{ name: 'HypeProof-Studio-darwin-arm64.zip', size: 100, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: 'https://github.com/jayleekr/hypeproof-studio-releases/releases/download/v0.1.51/HypeProof-Studio-darwin-arm64.zip' }],
};
try {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  Object.defineProperty(process, 'arch', { value: 'arm64' });
  globalThis.fetch = async () => Response.json(release);
  assert.equal((await checkForUpdates('0.1.50')).available, true);
  assert.equal((await checkForUpdates('0.1.51')).available, false);
  assert.equal((await checkForUpdates('0.1.52')).available, false);
  await assert.rejects(checkForUpdates('bad'), /버전/);
  for (const bad of [{ ...release, tag_name: '0.1.51garbage' }, { ...release, assets: null }, { ...release, assets: [] }, { ...release, assets: [{ ...release.assets[0], digest: undefined }] }]) {
    globalThis.fetch = async () => Response.json(bad);
    await assert.rejects(checkForUpdates('0.1.50'));
  }
  globalThis.fetch = async () => new Response('', { status: 429 });
  await assert.rejects(checkForUpdates('0.1.50'), /429/);
  Object.defineProperty(process, 'arch', { value: 'x64' });
  await assert.rejects(checkForUpdates('0.1.50'), /플랫폼/);
  Object.defineProperty(process, 'arch', { value: 'arm64' });

  const realTimeout = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  const callbacks = [];
  const banners = [];
  try {
    globalThis.setTimeout = (fn, ms) => { callbacks.push({ fn, ms }); return 0; };
    globalThis.setInterval = (fn, ms) => { callbacks.push({ fn, ms }); return 0; };
    const scheduler = scheduleUpdateChecks({ currentVersion: '0.1.50', context: { globalState: { get: () => ({}) } }, pushUpdateBanner: b => banners.push(b) });
    assert.equal(callbacks[0].ms, 30_000);
    callbacks[0].fn();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(banners, [], 'network failure must not clear the banner or claim latest');
    assert.equal(callbacks[1].ms, 24 * 60 * 60_000);
    globalThis.fetch = async () => Response.json(release);
    await callbacks[1].fn();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(banners.at(-1).version, '0.1.51');
    scheduler.dispose();
    const count = banners.length;
    callbacks[1].fn();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(banners.length, count);
  } finally { globalThis.setTimeout = realTimeout; globalThis.setInterval = realInterval; }
  console.log('PASS actual update orchestrator: check failures, platform, version, assets, cadence, banner retention and disposal');
} finally {
  globalThis.fetch = originalFetch;
  Object.defineProperty(process, 'platform', originalPlatform);
  Object.defineProperty(process, 'arch', originalArch);
}
