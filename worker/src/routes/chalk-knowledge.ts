// #1288 — Chalk 제품 지식 읽기 API.
// INSERT 전용 저장소: 한 번 쓴 버전은 바꾸지 않는다.
// issuer Bearer 전용 — 학생 토큰은 403.
import { Hono } from 'hono';
import type { Env } from '../env';
import { authorizeIssuer } from '../lib/instructor-auth';

interface KbVersion {
  version: number; parent_version: number | null; origin: string;
  source_repo: string | null; source_commit: string | null;
  note: string; created_by: string; created_at: number;
  doc_count: number; digest: string;
}
interface KbDoc {
  version: number; doc_id: string; kind: string;
  fields_json: string; body: string; source_path: string | null;
}

export const chalkKnowledge = new Hono<{ Bindings: Env }>();

// Global middleware: issuer Bearer required. KB is cohort-global — no scope check needed.
chalkKnowledge.use('/chalk/knowledge/*', async (c, next) => {
  const result = await authorizeIssuer(c);
  if (result === null) return c.json({ error: 'instructor Bearer required' }, 401);
  if (result instanceof Response) return result;
  c.header('cache-control', 'no-store');
  return next();
});

// GET /admin/chalk/knowledge/versions — list all versions, newest first.
chalkKnowledge.get('/chalk/knowledge/versions', async (c) => {
  const rows = await c.env.HPS_DB
    .prepare('SELECT * FROM chalk_knowledge_versions ORDER BY version DESC')
    .all<KbVersion>();
  return c.json({ versions: rows.results ?? [] });
});

// GET /admin/chalk/knowledge/:version/docs?kind= — list docs for a version.
chalkKnowledge.get('/chalk/knowledge/:version/docs', async (c) => {
  const ver = Number(c.req.param('version'));
  if (!Number.isInteger(ver) || ver < 1) return c.json({ error: 'invalid version' }, 400);
  const kind = c.req.query('kind');
  const versionRow = await c.env.HPS_DB
    .prepare('SELECT version FROM chalk_knowledge_versions WHERE version=?')
    .bind(ver).first<{ version: number }>();
  if (!versionRow) return c.json({ error: 'version not found' }, 404);
  const stmt = kind
    ? c.env.HPS_DB.prepare('SELECT * FROM chalk_knowledge_docs WHERE version=? AND kind=? ORDER BY doc_id').bind(ver, kind)
    : c.env.HPS_DB.prepare('SELECT * FROM chalk_knowledge_docs WHERE version=? ORDER BY kind, doc_id').bind(ver);
  const rows = await stmt.all<KbDoc>();
  return c.json({ version: ver, docs: (rows.results ?? []).map(d => ({ ...d, fields: JSON.parse(d.fields_json) })) });
});

// GET /admin/chalk/knowledge/:version/docs/:doc_id — get one doc.
chalkKnowledge.get('/chalk/knowledge/:version/docs/:doc_id', async (c) => {
  const ver = Number(c.req.param('version'));
  if (!Number.isInteger(ver) || ver < 1) return c.json({ error: 'invalid version' }, 400);
  const docId = c.req.param('doc_id')!;
  const row = await c.env.HPS_DB
    .prepare('SELECT * FROM chalk_knowledge_docs WHERE version=? AND doc_id=?')
    .bind(ver, docId).first<KbDoc>();
  if (!row) return c.json({ error: 'doc not found' }, 404);
  return c.json({ ...row, fields: JSON.parse(row.fields_json) });
});
