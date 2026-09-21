// #751 native voluntary help — every decision of the Studio help loop, without `vscode` (driven under plain Node by
// test/classroom-help.smoke.mjs). The host adapter (classroomHelpHost.ts) only reads/writes storage and the network.
//
// Contract (docs/requirements/classroom-admin.md ADM-03/05 and the native help section; AT-47):
//   - The recipient is never typed or chosen by the learner. It is what the Service derives for this learner's live class
//     connection (GET /v1/classroom/help-recipient), and the Service re-checks it when the request arrives.
//   - Nothing leaves before the learner has seen the exact content, the recipient, the expiry and how to withdraw, and has
//     ticked consent (never pre-ticked). The learner's own question can be sent alone; no conversation is attached unless
//     the learner picked that turn.
//   - A draft belongs to one learner in one class (cohort, profile, learner, class run). A prepared request additionally
//     belongs to the class connection it was previewed under. Another learner, class or connection never sees or sends it.
//   - "Sent" means the Service stored it. A lost answer is `unknown`, retried with the same id and the same envelope only.
//   - answered ≠ resolved: only the learner's explicit confirmation resolves. A failed read is `unknown`, not "no requests".

export const HELP_DURATIONS = [30, 60, 120] as const;
export const FIELD_MAX = 8000;
/** A learner's draft or prepared request that was not touched for this long is dropped from this device. */
export const LOCAL_RETENTION_MS = 24 * 3_600_000;

export interface HelpBinding { u: string; c: string; p: string; run: string; grant: string; seat: string }
export interface Assignment { recipient_id: string; class_run_id: string; seat_id: string; grant_id: string; class_ends_at: string; expires_cap: number }
export type Availability = { state: "ready"; assignment: Assignment } | { state: "unavailable"; reason: string } | { state: "unknown" };
export interface HelpDraft { question: string; turnId: string | null; duration: number; updated_at: number }
export interface HelpEnvelope {
  request_id: string; draft_key: string; send_key: string; recipient_id: string; class_run_id: string; grant_id: string; seat_id: string;
  duration_minutes: number; content: Record<string, string>; prepared_at: number; expiry_estimate: number; class_ends_at: string;
  /** prepared = previewed, not consented · sending = consented, the POST left (or may have) · unknown = its answer was lost */
  state: "prepared" | "sending" | "unknown";
  truncated: string[];
}
export interface HelpStore { drafts: Record<string, HelpDraft>; envelopes: Record<string, HelpEnvelope> }
export interface ShareRecord { id: string; session_id: string; status: string; revision: number; recipient_id: string; created_at: number; expires_at: number; content: Record<string, string>; feedback: string; next_action: string }
export interface HelpCard { id: string; status: string; label: string; revision: number; recipient_id: string; created_at: number; expires_at: number; content: Array<{ field: string; label: string; text: string }>; feedback: string; next_action: string; can_confirm: boolean }
export interface HelpTurn { id: string; text: string; at: number }
export interface HelpView {
  generation: number; draft_key: string | null; availability: Availability; seat: string | null;
  draft: HelpDraft; turns: HelpTurn[]; envelope: HelpEnvelope | null;
  current: HelpCard[]; history: HelpCard[]; refresh: { state: "ok" | "failed" | "never"; at: number | null }; note: string | null;
}

export const draftKey = (b: Pick<HelpBinding, "c" | "p" | "u" | "run">) => [b.c, b.p, b.u, b.run].join("|");
export const sendKey = (b: HelpBinding) => draftKey(b) + "|" + b.grant;
export const emptyStore = (): HelpStore => ({ drafts: {}, envelopes: {} });
export const emptyDraft = (): HelpDraft => ({ question: "", turnId: null, duration: HELP_DURATIONS[0], updated_at: 0 });

/** Who the learning token says this is (u/c/p). Unverified on purpose: only used to pick this learner's own local drafts. */
export function tokenLearner(token: string): { u?: string; c?: string; p?: string } {
  try {
    const b64 = (token.split(".")[0] ?? "").replace(/-/g, "+").replace(/_/g, "/"), bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
    return { ...(typeof p.u === "string" ? { u: p.u } : {}), ...(typeof p.c === "string" ? { c: p.c } : {}), ...(typeof p.p === "string" ? { p: p.p } : {}) };
  } catch { return {}; }
}
/** The learner of the token AND the learner of the live class connection must be the same person, or there is no binding. */
export function bindingOf(token: string, conn: { grant_id: string; class_run_id: string; seat_id: string; student?: { u: string; c: string; p: string } } | null): HelpBinding | null {
  const t = tokenLearner(token);
  if (!conn?.student || !t.u || !t.c || !t.p) return null;
  if (t.u !== conn.student.u || t.c !== conn.student.c || t.p !== conn.student.p) return null;
  return { u: t.u, c: t.c, p: t.p, run: conn.class_run_id, grant: conn.grant_id, seat: conn.seat_id };
}

export const FIELD_LABEL: Record<string, string> = { question: "내가 쓴 질문", prompt: "내가 AI에게 보낸 말", response: "AI의 답", tool_summary: "도구 실행 요약", artifact_url: "결과물 주소", verification: "내가 확인한 것" };
export const STATUS_LABEL: Record<string, string> = { received: "보냄 · 강사가 아직 열어 보지 않음", reviewing: "강사가 보는 중", answered: "강사 답변 도착 · 내 확인 전", resolved: "해결됐다고 내가 확인함" };

const clamp = (text: string, field: string, cut: string[]) => { if (text.length <= FIELD_MAX) return text; cut.push(field); return text.slice(0, FIELD_MAX); };
/**
 * Exactly what would be stored. The question is the learner's own words; a turn is the learner's message and the AI answer
 * that followed it, and only when the learner picked that turn. Empty fields are omitted (the Service stores omitted as "").
 */
export function buildContent(question: string, turn: { prompt: string; response: string } | null): { content: Record<string, string>; truncated: string[] } {
  const cut: string[] = [], content: Record<string, string> = {};
  const q = question.trim(); if (q) content.question = clamp(q, "question", cut);
  if (turn) { if (turn.prompt.trim()) content.prompt = clamp(turn.prompt, "prompt", cut); if (turn.response.trim()) content.response = clamp(turn.response, "response", cut); }
  return { content, truncated: cut };
}

/** The learner's messages since the class started, newest first — the only turns offered for sharing. */
export function turnsOf(history: Array<{ id: string; role: string; content: string; createdAt: number }>, since: number, max = 12): HelpTurn[] {
  return history.filter((m) => m.role === "user" && m.createdAt >= since && m.content.trim()).slice(-max).reverse().map((m) => ({ id: m.id, at: m.createdAt, text: m.content.trim().slice(0, 140) }));
}
/** A picked turn = that learner message + the assistant text that answered it (up to the next learner message). Tool lines are not included. */
export function turnContent(history: Array<{ id: string; role: string; content: string; createdAt: number }>, turnId: string, since: number): { prompt: string; response: string } | null {
  const i = history.findIndex((m) => m.id === turnId && m.role === "user" && m.createdAt >= since); if (i < 0) return null;
  const answer: string[] = []; for (let j = i + 1; j < history.length && history[j].role !== "user"; j++) if (history[j].role === "assistant" && history[j].content.trim()) answer.push(history[j].content);
  return { prompt: history[i].content, response: answer.join("\n\n") };
}

/**
 * From when a chat message may be offered for sharing. The chat history of a workspace is kept per class, not per learner,
 * so a message from before THIS window's class connection cannot be attributed to the learner who is here now (a shared
 * PC). Without a known connection time nothing is offered — the learner can still write their own question.
 */
export function turnsSince(conn: { connected_at?: number; run?: { starts_at: number } } | null): number {
  return conn?.connected_at ? Math.max(conn.connected_at, conn.run?.starts_at ?? 0) : Number.POSITIVE_INFINITY;
}

export function expiryEstimate(now: number, durationMinutes: number, capSec: number): number { return Math.min(now + durationMinutes * 60_000, capSec * 1000); }

export function makeEnvelope(o: { binding: HelpBinding; assignment: Assignment; draft: HelpDraft; content: Record<string, string>; truncated: string[]; now: number; id: string }): HelpEnvelope {
  const a = o.assignment, d = HELP_DURATIONS.includes(o.draft.duration as 30) ? o.draft.duration : HELP_DURATIONS[0];
  return { request_id: o.id, draft_key: draftKey(o.binding), send_key: sendKey(o.binding), recipient_id: a.recipient_id, class_run_id: a.class_run_id, grant_id: a.grant_id, seat_id: a.seat_id, duration_minutes: d, content: o.content, truncated: o.truncated, prepared_at: o.now, expiry_estimate: expiryEstimate(o.now, d, a.expires_cap), class_ends_at: a.class_ends_at, state: "prepared" };
}
/** The body sent. It names its class and connection so the Service refuses it (before writing) if either changed. */
export const requestBody = (e: HelpEnvelope) => ({ id: e.request_id, recipient_id: e.recipient_id, kind: "help", consent: true, duration_minutes: e.duration_minutes, class_run_id: e.class_run_id, grant_id: e.grant_id, content: e.content });

/**
 * May this envelope be sent from here, now? Local checks only — the Service decides again. The assignment is the one read
 * last; a different recipient, class or connection means the learner consented to something else.
 */
export function sendable(e: HelpEnvelope, binding: HelpBinding | null, assignment: Assignment | null, now: number): "ok" | "identity_changed" | "class_changed" | "recipient_changed" | "connection_changed" | "stale" {
  if (!binding || sendKey(binding) !== e.send_key) return binding && draftKey(binding) === e.draft_key ? "connection_changed" : "identity_changed";
  if (now > e.prepared_at + e.duration_minutes * 60_000) return "stale";
  if (!assignment) return "ok";
  if (assignment.class_run_id !== e.class_run_id) return "class_changed";
  if (assignment.grant_id !== e.grant_id) return "connection_changed";
  if (assignment.recipient_id !== e.recipient_id) return "recipient_changed";
  return "ok";
}

/** What an answer to the POST means. `stored` is the only outcome that says the request exists. */
export function classifyPost(status: number, reason?: string): "stored" | "unknown" | "changed" | "conflict" | "refused" {
  if (status === 200 || status === 201) return "stored";
  if (status === 0 || status >= 500 || status === 429) return "unknown";
  if (status === 409 && (reason === "class_changed" || reason === "connection_changed" || reason === "recipient_not_assigned")) return "changed";
  if (status === 409) return "conflict";
  if (status === 403 && ["not_connected", "no_instructor", "instructor_revoked", "no_active_class", "ops_disabled"].includes(reason ?? "")) return "changed";
  return "refused";
}

export function cardOf(s: ShareRecord): HelpCard {
  const content = Object.keys(FIELD_LABEL).filter((k) => typeof s.content?.[k] === "string" && s.content[k].trim()).map((k) => ({ field: k, label: FIELD_LABEL[k], text: s.content[k] }));
  return { id: s.id, status: s.status, label: STATUS_LABEL[s.status] ?? "상태 확인 불가", revision: s.revision, recipient_id: s.recipient_id, created_at: s.created_at, expires_at: s.expires_at, content, feedback: s.status === "answered" || s.status === "resolved" ? s.feedback : "", next_action: s.status === "answered" || s.status === "resolved" ? s.next_action : "", can_confirm: s.status === "answered" };
}
/** Current class vs. earlier classes, by the class each share was stored under — never by when it was read. */
export function splitShares(all: ShareRecord[], run: string): { current: HelpCard[]; history: HelpCard[] } {
  return { current: all.filter((s) => s.session_id === run).map(cardOf), history: all.filter((s) => s.session_id !== run).map(cardOf) };
}

/** Drafts and prepared requests the device no longer needs. The current learner's own entries are kept. */
export function prune(store: HelpStore, now: number, keep: string | null): HelpStore {
  const fresh = <T extends { updated_at?: number; prepared_at?: number }>(k: string, v: T) => k === keep || (keep !== null && k.startsWith(keep + "|")) || now - (v.updated_at ?? v.prepared_at ?? 0) < LOCAL_RETENTION_MS;
  return { drafts: Object.fromEntries(Object.entries(store.drafts).filter(([k, v]) => fresh(k, v))), envelopes: Object.fromEntries(Object.entries(store.envelopes).filter(([k, v]) => fresh(k, v))) };
}

/** Normalises a draft coming from the webview. Anything unexpected becomes the empty value; the text is kept as typed. */
export function cleanDraft(d: unknown, now: number): HelpDraft {
  const x = (d ?? {}) as Partial<HelpDraft>;
  return { question: typeof x.question === "string" ? x.question.slice(0, FIELD_MAX) : "", turnId: typeof x.turnId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(x.turnId) ? x.turnId : null, duration: HELP_DURATIONS.includes(x.duration as 30) ? (x.duration as number) : HELP_DURATIONS[0], updated_at: now };
}

export const REASON_TEXT: Record<string, string> = {
  no_token: "수업 참여 확인 전입니다. 참여 코드로 들어온 뒤에 도움을 요청할 수 있습니다.",
  not_paired: "이 창은 아직 수업에 연결되지 않았습니다. 강사에게 받은 ‘수업 연결’ 코드로 연결하면 강사에게 도움을 요청할 수 있습니다.",
  other_learner: "이 창의 수업 연결은 다른 참여자의 것입니다. 지금 로그인한 참여자로 다시 연결해야 도움을 요청할 수 있습니다.",
  not_connected: "이번 수업에서 이 자리의 연결이 확인되지 않습니다. 강사에게 새 연결 코드를 받아 주세요.",
  no_active_class: "지금 진행 중인 수업이 없어 도움 요청을 보낼 수 없습니다.",
  instructor_revoked: "이 수업의 강사 권한이 바뀌어 지금은 보낼 수 없습니다. 강사에게 직접 알려 주세요.",
  no_instructor: "이 자리에 연결된 강사를 확인할 수 없습니다. 강사에게 직접 알려 주세요.",
  ops_disabled: "이 수업 서버에서는 앱 안 도움 요청을 쓰지 않습니다. 강사에게 직접 손을 들어 주세요.",
  sharing_unavailable: "이 수업에서는 앱에서 강사에게 내용을 보낼 수 없습니다. 강사에게 직접 손을 들어 도움을 요청하세요.",
};
