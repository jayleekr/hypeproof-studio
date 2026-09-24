// #1288 — Chalk 지식 저장소: 로컬 D1 정상/부정 대조.
// 적재는 SQL fixture로 직접 넣는다. 쓰기 API는 없다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMiniflare } from './harness/miniflare.mjs';
import { bootApp, createMockEnv, makeCtx, TEST_SECRET } from './harness/index.mjs';

const compatibilityDate = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
  .match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(compatibilityDate, 'use the production Worker compatibility date');

const mf = createMiniflare({
  modules: true,
  script: 'export default {fetch(){return new Response("local test")}}',
  compatibilityDate,
  d1Databases: ['HPS_DB'],
});

try {
  const app = await bootApp();
  const db = await mf.getD1Database('HPS_DB');

  // 마이그레이션 적재 (idempotent)
  const migration = readFileSync(new URL('../migrations/0030-chalk-knowledge.sql', import.meta.url), 'utf8')
    .replace(/^--.*$/gm, '');
  for (const stmt of migration.split(';').map(s => s.trim()).filter(Boolean))
    await db.prepare(stmt).run();

  const env = createMockEnv({ env: { HPS_DB: db } });

  // 발급기 토큰 (cohort scope 포함 — issuerAllowedEndpoint 확인용)
  const { issueIssuer } = await import('../src/lib/tokens.ts');
  const { token: issuerToken } = await issueIssuer(
    { issuer: 'kb-test', scopes: [{ cohort: 'test-cohort', profiles: [] }] },
    2, TEST_SECRET,
  );

  // 학생 토큰
  const { issue } = await import('../src/lib/tokens.ts');
  const { token: studentToken } = await issue(
    { u: 'stu-1', c: 'test-cohort', p: 'test-profile' },
    2, TEST_SECRET,
  );

  async function call(path, { token = issuerToken, method = 'GET' } = {}) {
    const r = await app.fetch(
      new Request('https://local.test/admin' + path,
        { method, headers: { authorization: `Bearer ${token}` } }),
      env, makeCtx(),
    );
    return { status: r.status, body: await r.json() };
  }

  // v1 fixture 적재
  await db.prepare(`
    INSERT INTO chalk_knowledge_versions
      (version, parent_version, origin, source_repo, source_commit, note, created_by, created_at, doc_count, digest)
    VALUES (1, NULL, 'vault-import', 'hypeproof_kids_edu', 'abc123', 'initial import', 'kb-test', 1700000000000, 2, 'digest-v1')
  `).run();
  await db.prepare(`
    INSERT INTO chalk_knowledge_docs (version, doc_id, kind, fields_json, body, source_path)
    VALUES (1, 'method:m-001', 'method', '{"id":"m-001","family":"active-learning"}', 'Body of m-001.', 'methods/m-001.md')
  `).run();
  await db.prepare(`
    INSERT INTO chalk_knowledge_docs (version, doc_id, kind, fields_json, body, source_path)
    VALUES (1, 'vocab:goal', 'vocab', '{"keys":[{"key":"goal","label":"목표"}]}', '', 'rules/curriculum-schema.md')
  `).run();

  // 정상: 버전 목록
  const versionList = await call('/chalk/knowledge/versions');
  assert.equal(versionList.status, 200);
  assert.equal(versionList.body.versions.length, 1);
  assert.equal(versionList.body.versions[0].version, 1);
  assert.equal(versionList.body.versions[0].digest, 'digest-v1');

  // 정상: 문서 목록
  const docList = await call('/chalk/knowledge/1/docs');
  assert.equal(docList.status, 200);
  assert.equal(docList.body.docs.length, 2);

  // 정상: kind 필터
  const methodDocs = await call('/chalk/knowledge/1/docs?kind=method');
  assert.equal(methodDocs.status, 200);
  assert.equal(methodDocs.body.docs.length, 1);
  assert.equal(methodDocs.body.docs[0].doc_id, 'method:m-001');

  // 정상: 단일 문서 조회
  const singleDoc = await call('/chalk/knowledge/1/docs/method:m-001');
  assert.equal(singleDoc.status, 200);
  assert.equal(singleDoc.body.doc_id, 'method:m-001');
  assert.deepEqual(singleDoc.body.fields, { id: 'm-001', family: 'active-learning' });

  // v2 추가 — v1 바이트 불변 확인용
  await db.prepare(`
    INSERT INTO chalk_knowledge_versions
      (version, parent_version, origin, source_repo, source_commit, note, created_by, created_at, doc_count, digest)
    VALUES (2, 1, 'vault-import', 'hypeproof_kids_edu', 'def456', 'second import', 'kb-test', 1700001000000, 2, 'digest-v2')
  `).run();
  await db.prepare(`
    INSERT INTO chalk_knowledge_docs (version, doc_id, kind, fields_json, body, source_path)
    VALUES (2, 'method:m-001', 'method', '{"id":"m-001","family":"active-learning","evidence_grade":"A"}', 'Updated body.', 'methods/m-001.md')
  `).run();
  await db.prepare(`
    INSERT INTO chalk_knowledge_docs (version, doc_id, kind, fields_json, body, source_path)
    VALUES (2, 'vocab:goal', 'vocab', '{"keys":[{"key":"goal","label":"목표"}]}', '', 'rules/curriculum-schema.md')
  `).run();

  // 정상: v1·v2 모두 읽힘
  const versionList2 = await call('/chalk/knowledge/versions');
  assert.equal(versionList2.body.versions.length, 2);

  // v1 바이트 불변 — fields 내용이 바뀌지 않았어야 함
  const v1Doc = await call('/chalk/knowledge/1/docs/method:m-001');
  assert.equal(v1Doc.status, 200);
  assert.deepEqual(v1Doc.body.fields, { id: 'm-001', family: 'active-learning' });

  // v2는 갱신된 내용
  const v2Doc = await call('/chalk/knowledge/2/docs/method:m-001');
  assert.equal(v2Doc.status, 200);
  assert.equal(v2Doc.body.fields.evidence_grade, 'A');

  // 부정: 학생 토큰은 403
  const studentResp = await call('/chalk/knowledge/versions', { token: studentToken });
  assert.equal(studentResp.status, 403);

  // 부정: 없는 버전은 404
  const notFound = await call('/chalk/knowledge/99/docs');
  assert.equal(notFound.status, 404);

  // 부정: 없는 문서는 404
  const docNotFound = await call('/chalk/knowledge/1/docs/method:nonexistent');
  assert.equal(docNotFound.status, 404);

  // 부정: 같은 버전 재적재 시도 — SQLite UNIQUE 제약으로 거부
  try {
    await db.prepare(`
      INSERT INTO chalk_knowledge_versions
        (version, parent_version, origin, source_repo, source_commit, note, created_by, created_at, doc_count, digest)
      VALUES (1, NULL, 'vault-import', 'hypeproof_kids_edu', 'abc123', 'duplicate', 'kb-test', 1700000000000, 2, 'digest-v1')
    `).run();
    assert.fail('같은 버전 재적재는 거부되어야 한다');
  } catch (e) {
    assert.ok(e.message.includes('UNIQUE') || e.message.includes('PRIMARY KEY'), `constraint error expected, got: ${e.message}`);
  }

  console.log('PASS chalk-knowledge D1: 버전 목록, 문서 조회, kind 필터, v1 불변, 학생 403, 없는 버전/문서 404, 중복 버전 거부');
} finally {
  await mf.dispose();
}
