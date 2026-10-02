// #1469 (E3-3) — chalk_derive tool unit tests (extension layer).
// Node --experimental-strip-types (no worker harness).
//
// T-D1: normal — server HTML written to chalk/<course>/runbook.html, webPath returned
// T-D2: server 400 missing_ops propagated to caller as { error, message }
// T-D3: file not runbook/handout → server 400 invalid_file propagated
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';

const { execDerive, CHALK_TOOL_DEFINITIONS } = await import('../src/chalk/tools.ts');

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };

// ─── Mock server util ──────────────────────────────────────────────────────
async function withMockServer(handler, fn) {
  const server = createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try { await fn(port); } finally { server.close(); }
}

const fakeSecrets = { get: async () => 'tok-issuer', store: async () => {}, delete: async () => {}, keys: async () => [] };

const SAMPLE_HTML = `<!DOCTYPE html><html lang="ko" data-chalk-kind="runbook" data-chalk-derived-from="sha123"><head><meta charset="utf-8"><title>런북</title></head><body><h1>테스트 런북</h1></body></html>`;

// ─── T-D1: normal flow — writes HTML to working copy, returns webPath ──────
await check('T-D1 execDerive writes HTML to chalk/<course>/<file>.html and returns webPath', async () => {
  await withMockServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (req.url.includes('/derive') && req.method === 'POST') {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ html: SAMPLE_HTML, sha256: 'sha123', file: parsed.file ?? 'runbook', status: 'created' }));
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    });
  }, async (port) => {
    const cwd = join(tmpdir(), `chalk-derive-t-d1-${Date.now()}`);
    await mkdir(cwd, { recursive: true });
    const ctx = { serverUrl: `http://127.0.0.1:${port}`, secrets: fakeSecrets, cwd };
    const result = await execDerive(ctx, { cohort: 'test-cohort', course: 'test-course', file: 'runbook' });
    assert.equal(result.webPath, 'chalk/test-course/runbook.html', 'webPath must be chalk/<course>/runbook.html');
    const written = await readFile(join(cwd, 'chalk', 'test-course', 'runbook.html'), 'utf8');
    assert.equal(written, SAMPLE_HTML, 'written file must match server HTML');
  });
});

// ─── T-D2: server 400 missing_ops → { error: "missing_ops" } returned ──────
await check('T-D2 server 400 missing_ops propagated as { error, message } not thrown', async () => {
  await withMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'missing_ops', error: 'ops plan not yet saved' }));
    });
  }, async (port) => {
    const ctx = { serverUrl: `http://127.0.0.1:${port}`, secrets: fakeSecrets };
    const result = await execDerive(ctx, { cohort: 'test-cohort', course: 'test-course', file: 'runbook' });
    assert.equal(result.error, 'missing_ops', 'must propagate error code');
    assert.ok(typeof result.message === 'string', 'must include message string');
  });
});

// ─── T-D3: file not runbook/handout → server 400 invalid_file propagated ───
await check('T-D3 file=lesson server 400 invalid_file propagated as { error, message }', async () => {
  await withMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'invalid_file', error: 'file must be one of: runbook, handout' }));
    });
  }, async (port) => {
    const ctx = { serverUrl: `http://127.0.0.1:${port}`, secrets: fakeSecrets };
    const result = await execDerive(ctx, { cohort: 'test-cohort', course: 'test-course', file: 'lesson' });
    assert.equal(result.error, 'invalid_file', 'must propagate invalid_file error code');
    assert.ok(typeof result.message === 'string', 'must include message string');
  });
});

// ─── T-D4: chalk_derive in CHALK_TOOL_DEFINITIONS ───────────────────────────
await check('T-D4 chalk_derive in CHALK_TOOL_DEFINITIONS with required fields', () => {
  const def = CHALK_TOOL_DEFINITIONS.find(d => d.name === 'chalk_derive');
  assert.ok(def, 'chalk_derive must be in CHALK_TOOL_DEFINITIONS');
  assert.deepEqual(def.inputSchema.required.sort(), ['cohort', 'course', 'file'].sort());
});

console.log(`\nAll ${passed} tests passed.`);
