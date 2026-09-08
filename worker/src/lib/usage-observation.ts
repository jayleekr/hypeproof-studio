// A bounded view of stored metadata, not an attempt ledger or settled budget.
export interface StoredUsageRow {
  user_id: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  session_missing: number;
  latency_ms: number | null;
  status: number;
  created_at: string;
}

export function usageLimit(raw: string | undefined): number | null {
  if (raw === undefined) return 50;
  return /^[1-9][0-9]{0,2}$/.test(raw) && Number(raw) <= 500 ? Number(raw) : null;
}

export function usageObservation(rows: StoredUsageRow[], limit: number, hasOlderRecords: boolean) {
  const totals = { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0 };
  let failed = 0, failedWithTokens = 0, zeroTokenRecords = 0, unattributed = 0;
  for (const row of rows) {
    let positive = false;
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      const n = row[key];
      if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(totals[key] + n))
        throw new Error('invalid stored usage');
      totals[key] += n;
      positive ||= n > 0;
    }
    if (!Number.isInteger(row.status) || row.status < 100 || row.status > 599)
      throw new Error('invalid stored status');
    if (row.status >= 400) { failed++; if (positive) failedWithTokens++; }
    if (!positive) zeroTokenRecords++;
    if (row.session_missing === 1) unattributed++;
  }
  return {
    scope: 'recent_records' as const, limit, has_older_records: hasOlderRecords,
    fetched_at: new Date().toISOString(), record_count: rows.length,
    failed_records: failed, failed_with_tokens: failedWithTokens,
    zero_token_records: zeroTokenRecords, unattributed_session_records: unattributed,
    totals, completeness: 'unverified' as const,
    cost: { status: 'unknown' as const, amount: null,
      reasons: ['provider_and_price_revision_missing', 'attempt_coverage_unverified'] },
  };
}
