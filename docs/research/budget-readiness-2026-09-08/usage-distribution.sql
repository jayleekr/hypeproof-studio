WITH ranked AS (
 SELECT tokens_in,tokens_out,cache_read,cache_write,latency_ms,
 ROW_NUMBER() OVER(ORDER BY tokens_in+tokens_out) rn,COUNT(*) OVER() n
 FROM usage_log WHERE created_at>='2026-08-10' AND created_at<'2026-09-09 03:25:54'
)
SELECT COUNT(*) requests,SUM(tokens_in) input_tokens,SUM(tokens_out) output_tokens,SUM(cache_read) cache_read_tokens,SUM(cache_write) cache_write_tokens,
MAX(CASE WHEN rn=(50*n+99)/100 THEN tokens_in+tokens_out END) recorded_input_output_p50,
MAX(CASE WHEN rn=(95*n+99)/100 THEN tokens_in+tokens_out END) recorded_input_output_p95,
MAX(tokens_in+tokens_out) recorded_input_output_max,
ROUND(AVG(latency_ms)) mean_latency_ms FROM ranked;
WITH learners AS (SELECT cohort_id,user_id,SUM(tokens_in+tokens_out) tokens FROM usage_log WHERE created_at>='2026-08-10' AND created_at<'2026-09-09 03:25:54' GROUP BY cohort_id,user_id),
ranked AS (SELECT tokens,ROW_NUMBER() OVER(ORDER BY tokens DESC) rn,COUNT(*) OVER() n FROM learners)
SELECT COUNT(*) seat_identifiers,ROUND(100.0*SUM(CASE WHEN rn<=(10*n+99)/100 THEN tokens ELSE 0 END)/SUM(tokens),2) top_decile_share_of_recorded_input_output FROM ranked;
SELECT model,COUNT(*) requests,SUM(tokens_in) input_tokens,SUM(tokens_out) output_tokens,SUM(cache_read) cache_read_tokens,SUM(cache_write) cache_write_tokens FROM usage_log WHERE created_at>='2026-08-10' AND created_at<'2026-09-09 03:25:54' GROUP BY model HAVING COUNT(*)>=5 ORDER BY requests DESC;
