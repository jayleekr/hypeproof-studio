// MC-T01 legacy parity fixtures (#1042).
//
// `legacy-verdicts.json` next to this file was captured by running these exact
// cases through the ORIGINAL pre-extraction implementation
// (worker/src/lib/native-observation.ts at main e3efbf3). The extracted core must
// reproduce every verdict byte-for-byte: same accepted/rejected, same error code,
// same normalized order, same missing sequence list. A difference is a semantic
// change and must be resolved explicitly, never by regenerating the golden file.
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const ev = (id, seq, kind = "user", extra = {}) => ({
  id, seq, task: "task-1", at: seq, text: "새 직원이 주문을 확인할 문서가 필요해", kind, assistance: "unknown", ...extra,
});
const batch = (events, extra = {}) => ({
  format: "hps-observation/1", scope: "synthetic-seat", session: "s1", program: "m2026.09.08-1", events, ...extra,
});
const chain = () => [
  ev("u1", 1),
  ev("c1", 2, "coach", { text: "문서 초안을 만들겠습니다" }),
  ev("t1", 3, "tool_request", { tool_id: "tool-1", text: "Write(order.md)" }),
  ev("a1", 4, "approval", { tool_id: "tool-1", actor: "policy", outcome: "allowed", text: "정책 허용" }),
  ev("r1", 5, "tool_result", { tool_id: "tool-1", outcome: "success", text: "Write(order.md)" }),
  ev("f1", 6, "artifact", { sha256: SHA_A, text: "order.md" }),
];

export const batchCases = {
  normal_chain: () => batch(chain()),
  duplicate_identical_resend: () => batch([...chain(), chain()[0]]),
  conflicting_duplicate_id: () => batch([ev("a", 1), ev("a", 1, "coach")]),
  conflicting_sequence: () => batch([ev("a", 1), ev("b", 1)]),
  gap_in_sequence: () => batch([ev("u1", 1), ev("u3", 3)]),
  orphan_tool_result: () => batch([ev("r", 1, "tool_result", { tool_id: "absent", outcome: "success" })]),
  approval_invalid_actor: () => batch([
    ev("t", 1, "tool_request", { tool_id: "x" }),
    ev("a", 2, "approval", { tool_id: "x", actor: "ai", outcome: "allowed" }),
  ]),
  artifact_bad_hash: () => batch([ev("f", 1, "artifact", { sha256: "not-a-hash" })]),
  unsupported_old_format: () => ({ ...batch([]), format: "hps-observation/0" }),
  extra_field_rejected: () => batch([ev("u1", 1, "user", { secret: "must not pass through" })]),
  oversized_text: () => batch([ev("u1", 1, "user", { text: "x".repeat(20001) })]),
  too_many_events: () => batch(Array.from({ length: 501 }, (_, i) => ev("e" + i, i + 1))),
  request_only_no_result: () => batch([ev("u1", 1), ev("t1", 2, "tool_request", { tool_id: "tool-1" })]),
  reversed_order: () => batch([...chain()].reverse()),
  incomplete_flag: () => batch([ev("u1", 1)], { incomplete: true }),
  two_artifact_revisions: () => batch([...chain(), ev("f2", 7, "artifact", { sha256: SHA_B, text: "order.md" })]),
};

const unobserved = (asset) => ({ asset, status: "unobserved", interpretation: "근거 부족", evidence: [], assistance: "unknown", next: "다음 작업에서 확인" });
const ASSETS = ["TASTE", "INTENT", "CONTEXT", "VERIFY", "DELEGATE", "ITERATE", "OWNERSHIP"];
const withFinding = (index, patch) => ASSETS.map((a, i) => (i === index ? { ...unobserved(a), ...patch } : unobserved(a)));

export const findingCases = {
  all_unobserved: { batch: "normal_chain", findings: () => ASSETS.map(unobserved) },
  intent_observed_user_quote: { batch: "normal_chain", findings: () => withFinding(1, { status: "observed", interpretation: "대상과 목적을 제시했다", evidence: [{ event_id: "u1", quote: "새 직원" }] }) },
  fabricated_quote: { batch: "normal_chain", findings: () => withFinding(1, { status: "observed", evidence: [{ event_id: "u1", quote: "지어낸 인용" }] }) },
  missing_event_id: { batch: "normal_chain", findings: () => withFinding(1, { status: "observed", evidence: [{ event_id: "missing", quote: "새 직원" }] }) },
  assistant_only_citation: { batch: "normal_chain", findings: () => withFinding(1, { status: "observed", evidence: [{ event_id: "c1", quote: "문서 초안" }] }) },
  policy_approval_only_citation: { batch: "normal_chain", findings: () => withFinding(4, { status: "observed", evidence: [{ event_id: "a1", quote: "정책 허용" }] }) },
  score_field_rejected: { batch: "normal_chain", findings: () => { const f = ASSETS.map(unobserved); f[0].score = 100; return f; } },
  unsupported_independence: { batch: "normal_chain", findings: () => withFinding(1, { status: "observed", assistance: "independent", evidence: [{ event_id: "u1", quote: "새 직원" }] }) },
  verify_without_execution: { batch: "request_only_no_result", findings: () => withFinding(3, { status: "observed", evidence: [{ event_id: "u1", quote: "새 직원" }] }) },
  iterate_single_revision: { batch: "normal_chain", findings: () => withFinding(5, { status: "observed", evidence: [{ event_id: "u1", quote: "새 직원" }] }) },
  iterate_two_revisions: { batch: "two_artifact_revisions", findings: () => withFinding(5, { status: "observed", evidence: [{ event_id: "u1", quote: "새 직원" }] }) },
  six_findings_rejected: { batch: "normal_chain", findings: () => ASSETS.slice(0, 6).map(unobserved) },
  unobserved_with_evidence: { batch: "normal_chain", findings: () => withFinding(1, { evidence: [{ event_id: "u1", quote: "새 직원" }] }) },
  duplicate_asset: { batch: "normal_chain", findings: () => { const f = ASSETS.map(unobserved); f[6] = unobserved("TASTE"); return f; } },
};

const verdict = (fn) => {
  try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, code: error instanceof Error ? error.message : String(error) }; }
};

/** Runs every case through one implementation; returns a JSON-stable verdict map. */
export function runLegacyCases(impl) {
  const out = { batches: {}, findings: {} };
  for (const [name, make] of Object.entries(batchCases)) {
    const r = verdict(() => impl.validateObservation(make()));
    out.batches[name] = r.ok
      ? { ok: true, order: r.value.batch.events.map((e) => e.id), missing: r.value.missing, incomplete: r.value.batch.incomplete === true, observable: impl.observableAssets(r.value.batch) }
      : { ok: false, code: r.code };
  }
  for (const [name, c] of Object.entries(findingCases)) {
    const checked = impl.validateObservation(batchCases[c.batch]()).batch;
    const r = verdict(() => impl.validateFindings(c.findings(), checked));
    out.findings[name] = r.ok ? { ok: true, statuses: r.value.map((f) => f.asset + ":" + f.status) } : { ok: false, code: r.code };
  }
  return out;
}
