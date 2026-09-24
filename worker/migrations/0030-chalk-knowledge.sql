-- #1288: Chalk 제품 지식 저장소 — 버전 스냅숏과 문서 목록.
-- Additive. Every statement uses IF NOT EXISTS so re-application is safe.
-- 운영 적용은 J2 (JY 답 필요). deploy-worker.yml 에 추가하지 않는다.
CREATE TABLE IF NOT EXISTS chalk_knowledge_versions (
  version        INTEGER PRIMARY KEY,
  parent_version INTEGER,
  origin         TEXT NOT NULL CHECK (origin IN ('vault-import', 'product-edit')),
  source_repo    TEXT,
  source_commit  TEXT,
  note           TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  doc_count      INTEGER NOT NULL,
  digest         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chalk_knowledge_docs (
  version     INTEGER NOT NULL REFERENCES chalk_knowledge_versions(version),
  doc_id      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  source_path TEXT,
  PRIMARY KEY (version, doc_id)
);
