// Isolated Mac host for checking the CURRENT remote-classroom-operations build in a real Studio shell (#751).
//
//   node e2e/classroom/mac-devhost.mjs prepare   # copy → inject current build → ad-hoc sign the COPY → verify → manifest
//   node e2e/classroom/mac-devhost.mjs launch    # start a local Service + open the prepared copy against it
//
// Why this exists: the Mac may have an installed HypeProof Studio that is OLDER than this branch (2026-09-19: v0.1.16).
// Running that app proves nothing about this code, and must never be written down as if it did.
//   - /Applications is never modified and never launched by this script. Work happens on a COPY (HPS_DEVHOST_DIR).
//   - The copy's built-in `hypeproof-chat` is replaced by the CURRENT extension + webview build, and every bundle
//     hash is compared with the source build before anything opens.
//   - The copy runs with its own --user-data-dir / --extensions-dir and a LOCAL Service (SQLite + in-memory R2,
//     synthetic accounts). It has no production URL, no production token and no access to the user's Studio data.
//   - manifest.json states exactly what was run: shell version (possibly old), extension source SHA, bundle hashes.
//     Shell-level behaviour (updater, patches, signing) of an old shell is NOT evidence about a current release.
// The official shell rejects --extensionDevelopmentPath (see e2e/lesson-studio/README.md), hence the built-in copy.
// Nothing here downloads anything. A current official shell, when available, is used the same way via HPS_DEVHOST_SOURCE.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), mode = process.argv[2];
const source = process.env.HPS_DEVHOST_SOURCE || '/Applications/HypeProof Studio.app';
const home = path.resolve(process.env.HPS_DEVHOST_DIR || path.join(repo, 'e2e/test-results/classroom-devhost'));
const copy = path.join(home, 'HypeProof Studio (ops devhost).app'), ext = path.join(copy, 'Contents/Resources/app/extensions/hypeproof-chat');
const BUNDLES = ['dist/extension.js', 'webview-ui/dist/index.html', 'webview-ui/dist/assets/index.js', 'webview-ui/dist/assets/index.css'];
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex'), json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const inside = (child, parent) => { const r = path.relative(parent, child); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

export function preflight() {
  assert.equal(process.platform, 'darwin', 'this path is for a Mac; Windows builds are verified in GitHub Actions only');
  assert.ok(!inside(home, '/Applications') && home !== '/Applications', 'the working copy must not live in /Applications');
  assert.ok(inside(copy, home), 'internal: copy path escaped the working directory');
  for (const f of BUNDLES) assert.ok(existsSync(path.join(repo, 'extensions/hypeproof-chat', f)), `build first: missing ${f} (npm --prefix extensions/hypeproof-chat run build:extension && npm --prefix extensions/hypeproof-chat/webview-ui run build)`);
  assert.ok(existsSync(path.join(source, 'Contents/Resources/app/product.json')), 'no Studio shell to copy: set HPS_DEVHOST_SOURCE to an official .app');
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'extensions/hypeproof-chat/src', 'extensions/hypeproof-chat/webview-ui/src', 'worker/src', 'chalk/src'], { cwd: repo, encoding: 'utf8' }).trim();
  return { shell: json(path.join(source, 'Contents/Resources/app/product.json')), source_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), source_dirty: !!dirty };
}

function prepare() {
  const pre = preflight();
  rmSync(copy, { recursive: true, force: true }); mkdirSync(home, { recursive: true });
  cpSync(source, copy, { recursive: true, verbatimSymlinks: true }); // the original is only read
  for (const dir of ['dist', 'webview-ui/dist', 'media']) { const from = path.join(repo, 'extensions/hypeproof-chat', dir); if (!existsSync(from)) continue; rmSync(path.join(ext, dir), { recursive: true, force: true }); cpSync(from, path.join(ext, dir), { recursive: true }); }
  // The shell stamps the extension with the product version; keep that field so the shell's own checks behave as shipped, take everything else from source.
  const shipped = json(path.join(ext, 'package.json')), current = json(path.join(repo, 'extensions/hypeproof-chat/package.json'));
  writeFileSync(path.join(ext, 'package.json'), JSON.stringify({ ...current, version: shipped.version, devDependencies: undefined, scripts: undefined }, null, 2));
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', copy], { stdio: 'ignore' }); // ad-hoc, the COPY only
  const bundles = Object.fromEntries(BUNDLES.map((f) => { const a = sha(path.join(ext, f)), b = sha(path.join(repo, 'extensions/hypeproof-chat', f)); assert.equal(a, b, `${f} in the copy is not the current build`); return [f, a]; }));
  const manifest = { schema: 'hps-classroom-devhost/1', prepared_at: new Date().toISOString(), what_this_is: 'CURRENT extension + webview build inside a COPY of a Studio shell, isolated user data, local synthetic Service',
    what_this_is_not: ['the installed /Applications app', 'a current official release build', 'evidence about updater, signing, notarization or shell patches', 'a production Service, real learners, a school network or a real model'],
    shell: { copied_from: source, version: pre.shell.version, commit: pre.shell.commit, date: pre.shell.date, note: pre.shell.version !== current.version ? 'the shell is NOT the version this branch would ship in; only extension-level behaviour may be read from it' : '' },
    extension: { source_sha: pre.source_sha, source_dirty: pre.source_dirty, bundles, commands: current.contributes.commands.filter((c) => c.command.includes('classroom')).map((c) => c.command) },
    // No vendored Agent SDK in this copy (the v0.1.16 shell predates it and a source build does not vendor one): agent-sdk turns fall back to the proxy runtime.
    // That makes the SDK-fallback signal observable here, and means real SDK stop/reset behaviour is NOT covered by this host.
    agent_sdk_vendored: existsSync(path.join(ext, 'dist/vendor/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')),
    isolation: { user_data_dir: path.join(home, 'user-data'), extensions_dir: path.join(home, 'extensions'), service: 'http://127.0.0.1:<port>/v1 (in-process, SQLite + in-memory R2)' } };
  writeFileSync(path.join(home, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`prepared: ${copy}\n  shell ${manifest.shell.version} (copy) · extension source ${pre.source_sha.slice(0, 7)}${pre.source_dirty ? ' + uncommitted changes' : ''} · ${BUNDLES.length} bundle hashes match the current build\n  manifest: ${path.join(home, 'manifest.json')}\n  next: node e2e/classroom/mac-devhost.mjs launch`);
  return manifest;
}

async function launch() {
  assert.ok(existsSync(path.join(home, 'manifest.json')) && existsSync(copy), 'run `prepare` first');
  const manifest = json(path.join(home, 'manifest.json'));
  for (const [f, h] of Object.entries(manifest.extension.bundles)) assert.equal(sha(path.join(ext, f)), h, `${f} changed since prepare; prepare again`);
  const { localOps } = await import('../../worker/test/harness/classroom-ops.mjs'), { setRoster } = await import('../../worker/src/lib/kv.ts');
  const local = await localOps(); await local.freeze();
  const seats = [{ seat_id: 'A1', student_id: 'student-a' }, { seat_id: 'A2', student_id: 'student-b' }]; await setRoster(local.env.HPS_KV, local.cohort, seats.map((s) => s.student_id));
  assert.equal((await local.configure(seats, 0, { flags: { ops_observe: true, ops_commands: true, ops_collect: true, ops_reports: true } })).status, 201);
  const server = createServer(async (req, res) => { try { const parts = []; for await (const p of req) parts.push(p); const body = Buffer.concat(parts); const r = await local.app.fetch(new Request('https://service.test' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), local.env, { waitUntil() {} }); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); } catch { res.writeHead(500).end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = 'http://127.0.0.1:' + server.address().port;
  const userData = manifest.isolation.user_data_dir, settings = path.join(userData, 'User/settings.json'); mkdirSync(path.dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ 'hypeproofChat.proxyUrl': origin + '/v1', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off' }, null, 2)); // the ONLY Service this copy knows
  const token = await local.student('student-a'), ticket = (await local.request(local.base + '/pairings', 'POST', { seat_id: 'A1', roster_revision: 1 })).json.ticket, workspace = path.join(home, 'workspace'); mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(home, 'session.txt'), [`Local Service: ${origin} (synthetic; nothing here reaches production)`, `Instructor board data: GET ${origin}${local.base}/status  (Bearer = the instructor token below)`, `Instructor token: ${local.teacherToken}`, '', 'In the Studio COPY:', `  1. Paste this synthetic learner token when the chat panel asks: ${token}`, `  2. Command palette → “수업 연결” → code ${ticket} (10 minutes, single use)`, '  3. Open “내 수업”, press “채팅에 과제 넣기”, then “이 단계를 마쳤어요”; send a chat turn; try disconnect / reconnect.', '', 'Write results into docs/testing/classroom-admin.md as “isolated dev host (shell vX copy + current extension)”, with manifest.json. Never as a check of the installed app or of a release.'].join('\n'));
  console.log(readFileSync(path.join(home, 'session.txt'), 'utf8'));
  const app = spawn(path.join(copy, 'Contents/MacOS/HypeProof Studio'), ['--user-data-dir', userData, '--extensions-dir', manifest.isolation.extensions_dir, '--disable-updates', '--new-window', workspace], { stdio: 'ignore' });
  const stop = () => { app.kill(); server.close(); local.close(); }; process.on('SIGINT', () => { stop(); process.exit(0); });
  await once(app, 'exit'); stop();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (mode === 'prepare') prepare(); else if (mode === 'launch') await launch(); else if (mode === 'preflight') console.log(JSON.stringify(preflight(), null, 2));
  else { console.error('usage: node e2e/classroom/mac-devhost.mjs preflight | prepare | launch'); process.exit(2); }
}
