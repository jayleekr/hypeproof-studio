-- Explicit per-period resources. No production amounts or automatic renewals.
CREATE TABLE IF NOT EXISTS budget_accounts (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES access_periods(id),
  parent_id TEXT REFERENCES budget_accounts(id),
  kind TEXT NOT NULL CHECK(kind IN ('pool','allocation','cap')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('root','cohort','subject')),
  scope_id TEXT NOT NULL,
  max_concurrent INTEGER NOT NULL CHECK(max_concurrent > 0),
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  mutation_id TEXT,
  guard INTEGER NOT NULL DEFAULT 1 CHECK(guard=1),
  UNIQUE(period_id,parent_id,scope_kind,scope_id)
);
CREATE TABLE IF NOT EXISTS budget_limits (
  account_id TEXT NOT NULL REFERENCES budget_accounts(id),
  meter TEXT NOT NULL,
  granted INTEGER NOT NULL CHECK(granted >= 0),
  PRIMARY KEY(account_id,meter)
);
CREATE TABLE IF NOT EXISTS budget_roots (
  period_id TEXT PRIMARY KEY REFERENCES access_periods(id),
  account_id TEXT NOT NULL UNIQUE REFERENCES budget_accounts(id),
  subject_concurrency INTEGER NOT NULL CHECK(subject_concurrency > 0),
  revision INTEGER NOT NULL DEFAULT 1,
  document TEXT NOT NULL,
  digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budget_runtime_prices (
  root_id TEXT NOT NULL REFERENCES budget_accounts(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  protocol TEXT NOT NULL,
  price_revision TEXT NOT NULL REFERENCES usage_price_revisions(revision),
  PRIMARY KEY(root_id,provider,model,protocol)
);
CREATE TABLE IF NOT EXISTS budget_reservations (
  request_id TEXT PRIMARY KEY REFERENCES usage_attempt_costs(request_id),
  root_id TEXT NOT NULL REFERENCES budget_accounts(id),
  leaf_id TEXT NOT NULL REFERENCES budget_accounts(id),
  subject_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  document TEXT NOT NULL,
  admitted INTEGER NOT NULL CHECK(admitted=1)
);
CREATE INDEX IF NOT EXISTS budget_subject_requests ON budget_reservations(root_id,subject_key);
CREATE TABLE IF NOT EXISTS budget_reservation_lines (
  request_id TEXT NOT NULL REFERENCES budget_reservations(request_id),
  account_id TEXT NOT NULL REFERENCES budget_accounts(id),
  meter TEXT NOT NULL,
  bound INTEGER NOT NULL CHECK(bound >= 0),
  PRIMARY KEY(request_id,account_id,meter)
);
CREATE TABLE IF NOT EXISTS budget_reservation_scopes (
  request_id TEXT NOT NULL REFERENCES budget_reservations(request_id),
  account_id TEXT NOT NULL REFERENCES budget_accounts(id),
  PRIMARY KEY(request_id,account_id)
);
CREATE INDEX IF NOT EXISTS budget_scopes_account ON budget_reservation_scopes(account_id);
CREATE INDEX IF NOT EXISTS budget_lines_account ON budget_reservation_lines(account_id,meter);
CREATE INDEX IF NOT EXISTS usage_invoice_attempt ON usage_invoice_adjustments(request_id,currency);
CREATE TABLE IF NOT EXISTS budget_changes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES budget_accounts(id),
  actor TEXT NOT NULL,
  document TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Derive from the latest evidence; duplicate reports cannot spend again.
-- Unknown work keeps its original exposure even after a timeout.
CREATE VIEW IF NOT EXISTS budget_line_balances AS
WITH observations AS (
  SELECT l.*,a.execution_state,a.pricing_state,
    CASE WHEN l.meter='requests:count' THEN CASE WHEN a.execution_state IN ('reserved','not_sent') THEN 0 ELSE 1 END
      WHEN l.meter LIKE 'currency:%' THEN CASE WHEN l.meter='currency:'||a.currency||':micro' AND a.amount_micro IS NOT NULL
        THEN a.amount_micro+COALESCE((SELECT SUM(x.amount_micro) FROM usage_invoice_adjustments x WHERE x.request_id=l.request_id AND x.currency=a.currency),0) END
      WHEN a.execution_state='not_sent' THEN 0
      ELSE CAST(json_extract(e.document,'$.meters."'||l.meter||'"') AS INTEGER) END AS observed,
    CASE WHEN l.meter='requests:count' THEN CASE WHEN a.execution_state='reserved' THEN 0 ELSE 1 END
      WHEN a.execution_state='not_sent' THEN CASE WHEN l.meter LIKE 'currency:%' AND EXISTS(SELECT 1 FROM usage_invoice_adjustments x WHERE x.request_id=l.request_id AND x.amount_micro<>0) THEN 0 ELSE 1 END
      WHEN a.execution_state<>'ended' THEN 0
      WHEN l.meter LIKE 'currency:%' THEN CASE WHEN a.pricing_state='priced' AND l.meter='currency:'||a.currency||':micro' AND a.amount_micro IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM usage_invoice_adjustments x WHERE x.request_id=l.request_id AND x.currency<>a.currency) THEN 1 ELSE 0 END
      WHEN json_extract(e.document,'$.complete')=1 AND json_extract(e.document,'$.meters."'||l.meter||'"') IS NOT NULL THEN 1 ELSE 0 END AS final
  FROM budget_reservation_lines l JOIN usage_attempt_costs a ON a.request_id=l.request_id
  LEFT JOIN usage_cost_evidence e ON e.id=a.evidence_id
)
SELECT *,MAX(0,COALESCE(observed,0)) AS spent,
  CASE WHEN final=1 THEN 0 ELSE MAX(0,bound-MAX(0,COALESCE(observed,0))) END AS held,
  MAX(0,COALESCE(observed,0)-bound) AS overrun,
  MIN(0,COALESCE(observed,0)) AS unapplied_credit
FROM observations;
-- Dedicated children consume allocation once; cap children consume usage only.
CREATE VIEW IF NOT EXISTS budget_account_balances AS
WITH balances AS (
  SELECT l.account_id,l.meter,l.granted,
    COALESCE((SELECT SUM(v.granted) FROM budget_accounts c JOIN budget_limits v ON v.account_id=c.id
      WHERE c.parent_id=l.account_id AND c.kind='allocation' AND v.meter=l.meter),0) AS allocated,
    COALESCE((SELECT SUM(b.spent) FROM budget_line_balances b WHERE b.account_id=l.account_id AND b.meter=l.meter),0) AS spent,
    COALESCE((SELECT SUM(b.held) FROM budget_line_balances b WHERE b.account_id=l.account_id AND b.meter=l.meter),0) AS held,
    COALESCE((SELECT SUM(b.overrun) FROM budget_line_balances b WHERE b.account_id=l.account_id AND b.meter=l.meter),0) AS overrun,
    COALESCE((SELECT SUM(b.unapplied_credit) FROM budget_line_balances b WHERE b.account_id=l.account_id AND b.meter=l.meter),0) AS unapplied_credit,
    (SELECT COUNT(*) FROM budget_line_balances b WHERE b.account_id=l.account_id AND b.meter=l.meter AND b.final=0) AS unresolved
  FROM budget_limits l
)
SELECT *,granted-allocated-spent-held AS available FROM balances;
