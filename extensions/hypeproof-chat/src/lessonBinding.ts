// #751 U3 — the learner-device side of targeted lesson settings: pure rules and two small HTTP calls.
// No `vscode`. Contract: docs/requirements/classroom-admin.md#remote-management-u3-20260921.
//
// The device never decides which lesson runs. It (1) asks the Service to record a switch at the START of a turn, (2) adopts a
// profile only when the Service serves the key of that switch, (3) names that key as its EXPECTATION on every request of the
// turn, (4) tells the Service when the turn ended, and (5) when a turn is refused, closes it from the Service's record of
// that turn — never from a guess.

export const BINDING_HEADER = "x-hps-lesson-binding";
import type { LessonBindingView } from "./protocol";
export type { LessonBindingView };

/** The lesson the learner's OWN token pins. Unverified on purpose: the Service only uses it to NARROW where a binding applies. */
export function tokenLessonSha(token: string | null | undefined): string | null {
  // Decoded here (not via chatPanelHelpers) so that this file stays import-free and the tests can load it directly.
  let l: { sha256?: unknown } | undefined;
  try { l = JSON.parse(Buffer.from(String(token ?? "").split(".")[0] ?? "", "base64url").toString("utf8"))?.lesson; } catch { l = undefined; }
  return l && typeof l.sha256 === "string" && /^[a-f0-9]{64}$/.test(l.sha256) ? l.sha256 : null;
}

export type SwitchResult = { state: "none" } | { state: "switched"; key: string; seq: number; object_id: string; revision: number; content_hash: string; lesson: { course_id: string; version: string; sha256: string } | "base" } | { state: "failed"; reason: string; final: boolean };
export type PreflightPlan =
  | { action: "proceed" }                                   // nothing to adopt: the turn goes out under the profile this window has
  | { action: "adopt"; expectKey: string; lessonSha: string | null; confirm: boolean };
/**
 * What the turn preflight does next. `known` = the key the owner window last verified (shared inbox), for a window that
 * does not hold the seat. A switch that FAILED leaves everything as it was: the turn proceeds, the setting stays pending.
 */
export function planPreflight(current: LessonBindingView | undefined, sw: SwitchResult, known: string | null): PreflightPlan {
  if (!current?.enforced) return { action: "proceed" };
  if (sw.state === "switched") return sw.key === current.key ? { action: "proceed" } : { action: "adopt", expectKey: sw.key, lessonSha: sw.lesson === "base" ? null : sw.lesson.sha256, confirm: true };
  return known && known !== current.key ? { action: "adopt", expectKey: known, lessonSha: null, confirm: false } : { action: "proceed" };
}
/** A candidate profile is adopted only if the Service serves exactly the binding that was switched to. */
export function candidateMatches(plan: Extract<PreflightPlan, { action: "adopt" }>, candidate: { lesson_binding?: LessonBindingView; lesson?: { sha256?: string } } | null): boolean {
  return !!candidate?.lesson_binding && candidate.lesson_binding.key === plan.expectKey && (plan.lessonSha === null || candidate.lesson?.sha256 === plan.lessonSha);
}

export type TurnState = "not_started" | "dispatched" | "completed" | "failed" | "unknown";
export type RefusedTurnEnding = "restore_input" | "partial" | "unknown";
/**
 * How a turn that ended in a `lesson_binding` refusal is shown. Only the Service's successful answer "nothing was
 * dispatched" returns the learner's text and attachments to the composer. Anything dispatched = partially executed; anything
 * unreadable = unknown. Neither is ever re-sent automatically.
 */
export function refusedTurnEnding(state: TurnState | null): RefusedTurnEnding {
  if (state === "not_started") return "restore_input";
  return state === "dispatched" || state === "completed" || state === "failed" ? "partial" : "unknown";
}
export const REFUSAL_COPY: Record<RefusedTurnEnding, string> = {
  restore_input: "수업 설정이 바뀌어 보내지 않았습니다. 입력한 글과 첨부는 그대로 돌려 두었습니다. 다시 보내 주세요.",
  partial: "이 질문은 끝까지 실행되지 않았습니다(일부만 실행됨). 자동으로 다시 보내지 않습니다 — 필요하면 직접 다시 보내 주세요.",
  unknown: "이 질문이 실행됐는지 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.",
};
/**
 * Is this turn failure a refusal of the lesson-binding contract? The proxy client sees the JSON body. The SDK host sees only
 * text: observed on the pinned Agent SDK, a gateway 403 ends the turn at once (no retry) as
 * "Claude Code returned an error result: … API Error: 403 <message>", so the Service tags its message with `[hps:<code>]`.
 */
export function bindingRefusalCode(err: unknown): string | null {
  const e = err as { code?: unknown; kind?: unknown; message?: unknown } | null;
  for (const v of [e?.code, e?.kind]) if (typeof v === "string" && /^lesson_(binding|turn)_[a-z_]+$/.test(v)) return v;
  const m = typeof e?.message === "string" ? /\[hps:(lesson_(?:binding|turn)_[a-z_]+)\]/.exec(e.message) : null;
  return m ? m[1]! : null;
}

const v1 = (proxyUrl: string) => proxyUrl.replace(/\/+$/, "");
export async function fetchTurnState(o: { proxyUrl: string; token: string; turnId: string; fetchImpl?: typeof fetch }): Promise<TurnState | null> {
  try {
    const r = await (o.fetchImpl ?? fetch)(`${v1(o.proxyUrl)}/lesson-turns/${encodeURIComponent(o.turnId)}`, { headers: { authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const s = (await r.json() as { state?: string }).state;
    return s === "not_started" || s === "dispatched" || s === "completed" || s === "failed" || s === "unknown" ? s : null;
  } catch { return null; }
}
/** The host's statement that its turn ended. Best effort with two retries; a turn nobody closes is bounded by the Service. */
export async function closeTurn(o: { proxyUrl: string; token: string; turnId: string; outcome: "completed" | "aborted" | "failed"; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<boolean> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await (o.fetchImpl ?? fetch)(`${v1(o.proxyUrl)}/lesson-turns/${encodeURIComponent(o.turnId)}/close`, { method: "POST", headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" }, body: JSON.stringify({ outcome: o.outcome }), signal: AbortSignal.timeout(4000) });
      if (r.status < 500) return r.ok;
    } catch { /* retry */ }
    await sleep(500 * 2 ** attempt);
  }
  return false;
}
