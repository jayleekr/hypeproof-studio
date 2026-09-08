import type { Env, LLMProvider } from '../env';

export interface MeasuredUsage {
  state: 'reported' | 'partial' | 'missing';
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_write: number | null;
  reported_total: number | null;
  unclassified_tokens: number | null;
}
const count = (v: unknown): number | null => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;

/** Existing usage_log counts cache separately. Never add an inclusive cache twice.
 * Keep a provider's unexplained total as unclassified, not invented output/cost. */
export function measureUsage(provider: LLMProvider, raw: any, complete = true): MeasuredUsage {
  const native = provider === 'anthropic' || provider === 'glm';
  const input = count(native ? raw?.input_tokens : raw?.prompt_tokens);
  const output = count(native ? raw?.output_tokens : raw?.completion_tokens);
  const read = count(native ? raw?.cache_read_input_tokens : raw?.prompt_tokens_details?.cached_tokens);
  const write = count(native ? raw?.cache_creation_input_tokens : raw?.prompt_tokens_details?.cache_write_tokens);
  const validCache = input !== null && (native || (read ?? 0) + (write ?? 0) <= input);
  const ordinary = validCache ? input! - (native ? 0 : (read ?? 0) + (write ?? 0)) : input;
  const sum = input !== null && output !== null ? input + output + (native ? (read ?? 0) + (write ?? 0) : 0) : null;
  const total = native ? sum : count(raw?.total_tokens);
  const gap = total !== null && sum !== null ? total - sum : null;
  return {
    state: input === null && output === null ? 'missing' : complete && input !== null && output !== null && validCache && (gap === null || gap === 0) ? 'reported' : 'partial',
    tokens_in: ordinary, tokens_out: output, cache_read: validCache ? read : null,
    cache_write: validCache ? write : null, reported_total: total,
    unclassified_tokens: gap !== null && gap >= 0 ? gap : null,
  };
}

export interface ModelRequest {
  request_id: string; cohort_id: string; user_id: string; session_id: string;
  provider: LLMProvider; requested_model: string;
}

/** One atomic statement guards both lifetime attempts in this session and the seat slot.
 * Pending rows never silently expire: unknown work cannot free a paid-work slot. */
export async function reserveModelRequest(env: Env, r: ModelRequest, limit: number): Promise<boolean> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw Error('invalid model request limit');
  const result = await env.HPS_DB.prepare(`INSERT INTO model_usage_requests
    (request_id,cohort_id,user_id,session_id,provider,requested_model)
    SELECT ?,?,?,?,?,? WHERE
      (SELECT COUNT(*) FROM model_usage_requests WHERE cohort_id=? AND user_id=? AND session_id=?) < ?
      AND NOT EXISTS (SELECT 1 FROM model_usage_requests WHERE cohort_id=? AND user_id=? AND state='pending')
    ON CONFLICT(request_id) DO NOTHING`).bind(r.request_id,r.cohort_id,r.user_id,r.session_id,r.provider,r.requested_model,
      r.cohort_id,r.user_id,r.session_id,limit,r.cohort_id,r.user_id).run();
  return result.meta.changes === 1;
}

/** One terminal report per server-generated request ID; duplicates cannot spend twice. */
export async function finishModelRequest(env: Env, id: string, status: number, returnedModel: string | null, usage: MeasuredUsage): Promise<void> {
  await env.HPS_DB.prepare(`UPDATE model_usage_requests SET state=?,status=?,returned_model=?,
    tokens_in=?,tokens_out=?,cache_read=?,cache_write=?,reported_total=?,unclassified_tokens=?,
    finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE request_id=? AND state='pending'`)
    .bind(usage.state,status,returnedModel,usage.tokens_in,usage.tokens_out,usage.cache_read,usage.cache_write,
      usage.reported_total,usage.unclassified_tokens,id).run();
}

export async function modelUsageSummary(env: Env, cohort: string) {
  const rows = await env.HPS_DB.prepare(`SELECT session_id,user_id,provider,requested_model,
    COUNT(*) AS attempts,SUM(state='pending') AS pending,SUM(state IN ('partial','missing')) AS unconfirmed,
    SUM(tokens_in) AS tokens_in,SUM(tokens_out) AS tokens_out,SUM(cache_read) AS cache_read,
    SUM(cache_write) AS cache_write,SUM(reported_total) AS reported_total,SUM(unclassified_tokens) AS unclassified_tokens
    FROM model_usage_requests WHERE cohort_id=? GROUP BY session_id,user_id,provider,requested_model
    ORDER BY session_id,user_id,provider,requested_model LIMIT 1000`).bind(cohort).all();
  return { rows: rows.results, measured_at: new Date().toISOString(), scope: 'adult-model-practice',
    cost_status: 'unpriced', budget_kind: 'request-attempts', max_rows: 1000 };
}
