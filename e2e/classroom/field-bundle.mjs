// Remote classroom operations (#751) — the extension build a venue PC injects into a COPY of an official Studio shell.
//
//   npm --prefix extensions/hypeproof-chat run build:extension && (cd extensions/hypeproof-chat/webview-ui && npx vite build)
//   node e2e/classroom/field-bundle.mjs [outDir]          # default e2e/test-results/classroom-field-bundle
//
// Platform-independent JS only: no Agent SDK tree (the official shell already vendors it) and no native binary (seeded per
// machine by scripts/seed-sdk-binary.ps1). manifest.json names the source commit and the sha256 of every file, and
// e2e/classroom/win-field/prepare-devhost.ps1 refuses a bundle whose files do not match it. CI builds this on every PR
// (classroom-ops.yml → artifact `classroom-field-bundle`); a bundle built from a dirty tree says so and is not field evidence.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), ext = path.join(repo, 'extensions/hypeproof-chat');
const json = (p) => JSON.parse(readFileSync(p, 'utf8')), sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const walk = (dir, base = dir) => readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')]; });

export function buildFieldBundle(outDir) {
  for (const f of ['dist/extension.js', 'webview-ui/dist/index.html']) if (!existsSync(path.join(ext, f))) throw Error(`build first: missing ${f}`);
  rmSync(outDir, { recursive: true, force: true }); const to = path.join(outDir, 'extension'); mkdirSync(path.join(to, 'dist'), { recursive: true });
  cpSync(path.join(ext, 'dist/extension.js'), path.join(to, 'dist/extension.js'));
  for (const dir of ['webview-ui/dist', 'media']) if (existsSync(path.join(ext, dir))) cpSync(path.join(ext, dir), path.join(to, dir), { recursive: true });
  // The shell's own version is kept at injection time (the updater and verify-branding read it); everything a packaged build must not carry is dropped.
  const pkg = json(path.join(ext, 'package.json')); writeFileSync(path.join(to, 'package.json'), JSON.stringify({ ...pkg, devDependencies: undefined, scripts: undefined }, null, 2));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  const manifest = { schema: 'hps-classroom-field-bundle/1', built_at: new Date().toISOString(), source_sha: git('rev-parse', 'HEAD'),
    source_dirty: !!git('status', '--porcelain', '--', 'extensions/hypeproof-chat/src', 'extensions/hypeproof-chat/webview-ui/src', 'extensions/hypeproof-chat/package.json'),
    extension_version_in_source: pkg.version, agent_sdk_pinned: json(path.join(ext, 'package-lock.json')).packages['node_modules/@anthropic-ai/claude-agent-sdk']?.version ?? null,
    commands_required: pkg.contributes.commands.map((c) => c.command).filter((c) => c.includes('classroom')),
    files: Object.fromEntries(walk(to).sort().map((f) => [f, sha(path.join(to, f))])),
    not_included: ['Agent SDK JS tree (kept from the official shell copy)', 'native claude binary (scripts/seed-sdk-binary.ps1)', 'any token, URL or account'] };
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2)); return manifest;
}
if (import.meta.url === `file://${process.argv[1]}`) { const out = path.resolve(process.argv[2] || path.join(repo, 'e2e/test-results/classroom-field-bundle')), m = buildFieldBundle(out); console.log(`field bundle: ${out}\n  source ${m.source_sha.slice(0, 7)}${m.source_dirty ? ' + UNCOMMITTED CHANGES (not field evidence)' : ''} · ${Object.keys(m.files).length} files · classroom commands ${m.commands_required.length}`); }
