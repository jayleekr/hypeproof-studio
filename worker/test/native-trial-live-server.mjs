// Real gateway + real upstream, synthetic in-memory KV/D1/Analytics bindings.
// Never deploys or reads/writes a production cohort. Not a D1 integration test.
import './harness/loader.mjs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootApp, createMockEnv, makeCtx } from './harness/index.mjs';
const { issue } = await import('../src/lib/tokens.ts');

if (!process.env.ANTHROPIC_API_KEY) throw new Error('BLOCKED: ANTHROPIC_API_KEY is not configured in this test runner');
const output = resolve(process.env.HPS_NATIVE_EVIDENCE_DIR || '../e2e/test-results/native-trial');
mkdirSync(output, { recursive: true });
const signing = randomBytes(32).toString('hex');
const env = createMockEnv({ withSession: false, withRoster: false, secret: signing, env: {
  LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: undefined, ANTHROPIC_PROXY_URL: undefined,
  GALLERY_LOGS_BASE: undefined, HPS_ADMIN_PASSWORD: undefined,
} });
const now = Date.now(), id = 'studio-native-trial';
await env.HPS_KV.put(`cohort:${id}:active_session`, JSON.stringify({ session_id: 'native-ci', profile_id: id,
  starts_at: new Date(now - 60000).toISOString(), ends_at: new Date(now + 3600000).toISOString() }));
await env.HPS_KV.put(`cohort:${id}:roster`, JSON.stringify({ users: ['synthetic-adult'], updated_at: new Date(now).toISOString() }));
const { token } = await issue({ u: 'synthetic-adult', c: id, p: id }, 1, signing);
// File deliberately lives outside evidence; never print or upload it.
writeFileSync(process.env.HPS_E2E_TOKEN_FILE || '/tmp/hps-native-trial-token', token, { mode: 0o600 });

const app = await bootApp();
const calls = [];
let attempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== 'https://api.anthropic.com') throw new Error('unexpected upstream origin in isolated trial test');
  if (++attempts > 24) throw new Error('live rehearsal request budget exhausted (24); inspect the recorded failure before rerunning');
  const start = Date.now();
  const response = await realFetch(input, { ...init, signal: AbortSignal.any([
    ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(90000),
  ]) });
  calls.push({ origin: url.origin, path: url.pathname, status: response.status,
    request_id: response.headers.get('request-id'), elapsed_ms: Date.now() - start });
  writeFileSync(resolve(output, 'api-evidence.json'), JSON.stringify({ real_upstream: true, storage: 'synthetic-memory', calls }, null, 2));
  return response;
};
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const method = req.method || 'GET', ctx = makeCtx();
    const request = new Request(`http://127.0.0.1:8787${req.url}`, { method, headers: req.headers,
      ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) }) });
    const response = await app.fetch(request, env, ctx);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
    await ctx.settle();
  } catch { if (!res.headersSent) res.writeHead(500); res.end('isolated test gateway error'); }
});
server.listen(8787, '127.0.0.1', () => console.log('Isolated native trial gateway ready; real Anthropic upstream; synthetic storage'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
