// Local rehearsal gateway for a seat whose cohort lets the student NAME the AI
// (`naming_mode: "user_names_it"`), so #832 (AE-08 — history keeps the name it
// was answered under) can actually be exercised by hand.
//
// The native-trial rehearsal server cannot do this: its cohort is
// `naming_mode: "fixed"`, and it generates a random signing secret per boot so
// no externally minted token is accepted.
//
// Same posture as that server: real Anthropic upstream, synthetic in-memory
// KV/D1, never a production cohort, request budget capped.
import './harness/loader.mjs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { bootApp, createMockEnv, makeCtx, COHORT, USER } from './harness/index.mjs';
const { issue } = await import('../src/lib/tokens.ts');

const port = Number(process.env.HPS_KIDS_PORT || 8788);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('invalid gateway port');
if (!process.env.ANTHROPIC_API_KEY) throw new Error('BLOCKED: ANTHROPIC_API_KEY is not configured');

// NOTE the filename/id split: `sk-biopharm-kids-s1.ts` declares
// `id: "sk-biopharm-kids-2026-grade-3-4-s1"`. The id is what getProfile keys
// on, and it is also the harness default, so the mock roster + open session
// already match this seat (#367: roster before token).
const PROFILE = process.env.HPS_KIDS_PROFILE || 'sk-biopharm-kids-2026-grade-3-4-s1';
const signing = randomBytes(32).toString('hex');

const env = createMockEnv({
  secret: signing,
  env: {
    LLM_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_PROXY_URL: undefined,
    GALLERY_LOGS_BASE: undefined,
    HPS_ADMIN_PASSWORD: undefined,
  },
});
// The mock session pins its own profile id; point it at the naming cohort so
// the seat and the session agree.
const sessionKey = `cohort:${COHORT}:active_session`;
const session = JSON.parse(await env.HPS_KV.get(sessionKey));
await env.HPS_KV.put(sessionKey, JSON.stringify({ ...session, profile_id: PROFILE }));

const app = await bootApp();
// 12h, per .claude/rules/verification.md: a verification seat that expires
// mid-session sends the tester chasing a 401 that is not the bug they were
// looking at. Local synthetic storage only — this seat reaches no classroom.
const HOURS = Number(process.env.HPS_KIDS_HOURS || 12);
const { token } = await issue({ u: USER, c: COHORT, p: PROFILE }, HOURS, signing);
writeFileSync(process.env.HPS_KIDS_TOKEN_FILE || '/tmp/hpstest/token.kids', token, { mode: 0o600 });

let attempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== 'https://api.anthropic.com') throw new Error('unexpected upstream origin');
  if (++attempts > 40) throw new Error('local rehearsal request budget exhausted (40)');
  return realFetch(input, {
    ...init,
    signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(90000)]),
  });
};

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const method = req.method || 'GET';
    const ctx = makeCtx();
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
      method,
      headers: req.headers,
      ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) }),
    });
    const response = await app.fetch(request, env, ctx);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
    await ctx.settle();
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end('local gateway error');
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`kids rename gateway ready on ${port}; profile=${PROFILE}; real Anthropic; synthetic storage`),
);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
