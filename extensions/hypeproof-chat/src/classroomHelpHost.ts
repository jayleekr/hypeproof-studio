// #751 native voluntary help — host adapter. Storage (globalState, shared by every window of this app), fetch and the chat
// history live here; every decision is in classroomHelp.ts. The learning token and the class connection are read fresh for
// every action, and every answer is checked against them again when it comes back: a response that returns after the
// learner, class or connection changed is never shown to whoever is there now.
import * as vscode from "vscode";
import { randomUUID } from "crypto";
import {
  bindingOf, buildContent, classifyPost, cleanDraft, draftKey, emptyDraft, emptyStore, makeEnvelope, prune, requestBody, sendKey, sendable,
  splitShares, turnContent, turnsOf, turnsSince, type Assignment, type Availability, type HelpBinding, type HelpEnvelope, type HelpStore, type HelpView, type ShareRecord,
} from "./classroomHelp";

const STORE_KEY = "hypeproof.classroomHelp.v1";
type Conn = { grant_id: string; class_run_id: string; seat_id: string; connected_at?: number; student?: { u: string; c: string; p: string }; run?: { starts_at: number; ends_at: number } } | null;
export interface HelpHostDeps {
  token(): Promise<string>;
  /** This window's LIVE class connection (null when not paired, ended, revoked or replaced). */
  connection(): Conn;
  base(): string;
  history(): Array<{ id: string; role: string; content: string; createdAt: number }>;
  post(view: HelpView): void;
  log(line: string): void;
}
type Call = { status: number; json: any };

export class ClassroomHelpHost {
  private generation = 0;
  private note: string | null = null;
  private lastGood = new Map<string, { shares: ShareRecord[]; at: number }>();
  private lastAssignment: Assignment | null = null;
  private busy = false;
  private noteKey: string | null = null;
  constructor(private readonly state: vscode.Memento, private readonly deps: HelpHostDeps) {}

  private store(): HelpStore { const s = this.state.get<HelpStore>(STORE_KEY); return s && s.drafts && s.envelopes ? s : emptyStore(); }
  private async save(s: HelpStore, keep: string | null): Promise<void> { await this.state.update(STORE_KEY, prune(s, Date.now(), keep)); }
  private async call(path: string, token: string, init: RequestInit = {}): Promise<Call> {
    try {
      const r = await fetch(`${this.deps.base()}/classroom/${path}`, { ...init, signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    } catch { return { status: 0, json: {} }; }
  }
  /** Who is here now: the stored learning token + this window's live connection, and they must be the same learner. */
  private async who(): Promise<{ token: string; binding: HelpBinding | null; reason: string | null; conn: Conn }> {
    const token = (await this.deps.token()) || "", conn = this.deps.connection();
    if (!token) return { token, binding: null, reason: "no_token", conn };
    if (!conn) return { token, binding: null, reason: "not_paired", conn };
    const binding = bindingOf(token, conn);
    return { token, binding, reason: binding ? null : "other_learner", conn };
  }
  private async assignment(token: string): Promise<Availability> {
    const r = await this.call("help-recipient", token);
    if (r.status === 200 && r.json?.available === true && typeof r.json.recipient_id === "string") return { state: "ready", assignment: r.json as Assignment };
    if (r.status === 200 && typeof r.json?.reason === "string") return { state: "unavailable", reason: r.json.reason };
    // The student gate: a minor cohort (no guardian-consent contract yet) or a learner outside the roster.
    if (r.status === 403 && /sharing unavailable/.test(String(r.json?.error ?? ""))) return { state: "unavailable", reason: "sharing_unavailable" };
    return { state: "unknown" };
  }

  /** Read everything again and draw it. `note` is the result of the learner's last action, said once. */
  async refresh(note?: string | null): Promise<void> {
    if (note !== undefined) this.note = note;
    const gen = ++this.generation, w = await this.who();
    const empty = (availability: Availability): HelpView => ({ generation: gen, draft_key: null, availability, seat: null, draft: emptyDraft(), turns: [], envelope: null, current: [], history: [], refresh: { state: "never", at: null }, note: this.note });
    if (!w.binding) { this.lastAssignment = null; this.noteKey = null; if (note === undefined) this.note = null; this.deps.post(empty({ state: "unavailable", reason: w.reason ?? "not_paired" })); return; }
    const b = w.binding, dk = draftKey(b), sk = sendKey(b);
    if (this.noteKey !== sk) { this.noteKey = sk; if (note === undefined) this.note = null; } // a note is never carried to another learner or connection
    // The current class is read with the Service's class filter (never cut off by older history); history separately.
    const [availability, cur, all] = await Promise.all([this.assignment(w.token), this.call("shares?session_id=" + encodeURIComponent(b.run), w.token), this.call("shares", w.token)]);
    // Whatever came back belongs to the learner/connection it was asked for. Somebody else there now → drawn by a later refresh.
    const now = await this.who(); if (gen !== this.generation || !now.binding || sendKey(now.binding) !== sk) return;
    this.lastAssignment = availability.state === "ready" ? availability.assignment : null;
    let shares: ShareRecord[] | null = null;
    if (cur.status === 200 && Array.isArray(cur.json?.shares) && all.status === 200 && Array.isArray(all.json?.shares)) {
      const seen = new Set<string>(); shares = [...cur.json.shares, ...all.json.shares].filter((x: ShareRecord) => !seen.has(x.id) && !!seen.add(x.id)) as ShareRecord[];
      this.lastGood.set(dk, { shares, at: Date.now() });
    }
    const good = this.lastGood.get(dk), split = splitShares(good?.shares ?? [], b.run);
    let store = this.store(); const env = store.envelopes[sk] ?? null;
    // A request whose answer was lost: if the Service has it, it was stored — the envelope is done. Otherwise it stays unknown.
    if (env && env.state !== "prepared" && shares?.some((s) => s.id === env.request_id)) { delete store.envelopes[sk]; await this.save(store, dk); store = this.store(); this.note = "보낸 도움 요청이 서버에 저장된 것을 확인했습니다."; }
    const since = turnsSince(this.deps.connection());
    this.deps.post({
      generation: gen, draft_key: dk, availability, seat: b.seat, draft: store.drafts[dk] ?? emptyDraft(), turns: turnsOf(this.deps.history(), since),
      envelope: store.envelopes[sk] ?? null, current: split.current, history: split.history,
      refresh: shares ? { state: "ok", at: Date.now() } : { state: good ? "failed" : "never", at: good?.at ?? null }, note: this.note,
    });
  }

  /** Keep what the learner typed, for this learner in this class only. Refused if the view was drawn for someone else. */
  async draft(key: string, raw: unknown): Promise<void> {
    const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key) return;
    const s = this.store(); s.drafts[key] = cleanDraft(raw, Date.now()); await this.save(s, key);
  }

  /** Freeze exactly what would be sent, for this learner, class, connection and recipient. Nothing leaves this device here. */
  async preview(key: string, raw: unknown): Promise<void> {
    const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key) { await this.refresh("수업 연결이나 참여자가 바뀌어 미리 보기를 만들지 않았습니다."); return; }
    const b = w.binding, s = this.store(), draft = cleanDraft(raw, Date.now()); s.drafts[key] = draft;
    const availability = await this.assignment(w.token);
    if (availability.state !== "ready") { await this.save(s, key); await this.refresh(availability.state === "unknown" ? "받는 강사를 지금 확인할 수 없습니다. 잠시 뒤 다시 시도해 주세요." : null); return; }
    const since = turnsSince(this.deps.connection()), turn = draft.turnId ? turnContent(this.deps.history(), draft.turnId, since) : null;
    if (draft.turnId && !turn) { await this.save(s, key); await this.refresh("고른 대화를 이번 수업 기록에서 찾지 못했습니다. 다시 골라 주세요."); return; }
    const { content, truncated } = buildContent(draft.question, turn);
    if (!Object.keys(content).length) { await this.save(s, key); await this.refresh("질문을 쓰거나 보낼 대화를 하나 골라 주세요."); return; }
    s.envelopes[sendKey(b)] = makeEnvelope({ binding: b, assignment: availability.assignment, draft, content, truncated, now: Date.now(), id: randomUUID() });
    await this.save(s, key); await this.refresh(null);
  }
  async cancel(key: string): Promise<void> {
    const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key) return;
    const s = this.store(), e = s.envelopes[sendKey(w.binding)];
    // A consented request whose answer is unknown is not silently forgotten: it may exist on the Service.
    if (e && e.state === "prepared") { delete s.envelopes[sendKey(w.binding)]; await this.save(s, key); }
    await this.refresh("보내지 않았습니다. 쓴 질문은 그대로 있습니다.");
  }

  /** The learner ticked consent and pressed send (or retries a request whose answer was lost — same id, same envelope). */
  async send(key: string, requestId: string, consent: boolean): Promise<void> {
    if (this.busy) return; this.busy = true;
    try {
      const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key) { await this.refresh("수업 연결이나 참여자가 바뀌어 보내지 않았습니다."); return; }
      const b = w.binding, sk = sendKey(b), s = this.store(), e = s.envelopes[sk];
      if (!e || e.request_id !== requestId) { await this.refresh("미리 본 내용이 바뀌었습니다. 다시 확인해 주세요."); return; }
      if (e.state === "prepared" && consent !== true) { await this.refresh("동의 확인란을 선택해야 보낼 수 있습니다."); return; }
      const ok = sendable(e, b, this.lastAssignment, Date.now());
      if (ok !== "ok") { if (e.state === "prepared") { delete s.envelopes[sk]; await this.save(s, key); } await this.refresh(ok === "stale" ? "미리 본 지 오래되어 보내지 않았습니다. 다시 확인해 주세요." : "받는 강사나 수업 연결이 바뀌어 보내지 않았습니다. 내용을 다시 확인해 주세요."); return; }
      // Written BEFORE the request leaves: after a crash or a lost answer this device knows a request may exist.
      s.envelopes[sk] = { ...e, state: "sending" }; await this.save(s, key);
      const r = await this.call("shares", w.token, { method: "POST", body: JSON.stringify(requestBody(e)) });
      const verdict = classifyPost(r.status, r.json?.reason), after = this.store(), mine = after.envelopes[sk];
      if (verdict === "stored") { delete after.envelopes[sk]; const d = after.drafts[key]; if (d && d.question.trim() === (e.content.question ?? "")) after.drafts[key] = { ...d, question: "", turnId: null, updated_at: Date.now() }; }
      else if (verdict === "unknown") { if (mine) after.envelopes[sk] = { ...mine, state: "unknown" }; }
      else delete after.envelopes[sk];
      await this.save(after, key);
      // The answer is drawn only for the learner/connection it belongs to (refresh re-checks who is here).
      await this.refresh(verdict === "stored" ? "강사에게 보냈습니다. 강사가 답하면 여기에 표시됩니다." : verdict === "unknown" ? "보냈는지 확인하지 못했습니다. ‘다시 확인’을 누르면 같은 요청으로 다시 확인합니다(중복되지 않습니다)." : verdict === "changed" ? "받는 강사나 수업 연결이 바뀌어 저장되지 않았습니다. 쓴 질문은 그대로 있습니다." : "요청이 받아들여지지 않았습니다. 쓴 질문은 그대로 있습니다.");
    } finally { this.busy = false; }
  }

  /** A request whose answer was lost and that the Service does not list is retried with the same id and envelope. */
  async retry(key: string): Promise<void> {
    const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key) return;
    const e = this.store().envelopes[sendKey(w.binding)]; if (!e || e.state === "prepared") return;
    const listed = await this.call("shares?session_id=" + encodeURIComponent(e.class_run_id), w.token);
    if (listed.status === 200 && Array.isArray(listed.json?.shares) && listed.json.shares.some((x: ShareRecord) => x.id === e.request_id)) { await this.refresh(null); return; }
    if (listed.status !== 200) { await this.refresh("지금은 서버에 확인할 수 없습니다. 보낸 요청은 이 기기에 그대로 있습니다."); return; }
    await this.send(key, e.request_id, true);
  }

  async confirm(key: string, id: string, revision: number): Promise<void> {
    const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !Number.isInteger(revision)) return;
    const r = await this.call(`shares/${encodeURIComponent(id)}/confirm`, w.token, { method: "POST", body: JSON.stringify({ expected_revision: revision }) });
    await this.refresh(r.status === 200 ? "해결됐다고 강사에게 알렸습니다." : r.status === 409 ? "그 사이 강사가 답을 고쳤거나 요청이 만료됐습니다. 새로 읽은 내용을 확인해 주세요." : "확인을 보내지 못했습니다. 다시 시도해 주세요.");
  }
  async withdraw(key: string, id: string): Promise<void> {
    const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return;
    const r = await this.call(`shares/${encodeURIComponent(id)}`, w.token, { method: "DELETE" });
    await this.refresh(r.status === 200 ? "공유를 철회했습니다. 강사는 더 이상 이 내용을 열 수 없습니다." : r.status === 404 ? "이미 철회됐거나 만료된 공유입니다." : "철회하지 못했습니다. 다시 시도해 주세요.");
  }
  /** A lost-answer request the learner no longer wants: dropped here AND withdrawn on the Service if it exists there. */
  async discard(key: string): Promise<void> {
    const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key) return;
    const s = this.store(), sk = sendKey(w.binding), e = s.envelopes[sk]; if (!e) return;
    const r = await this.call(`shares/${encodeURIComponent(e.request_id)}`, w.token, { method: "DELETE" });
    if (r.status !== 200 && r.status !== 404) { await this.refresh("지금은 서버에서 지우지 못했습니다. 요청은 이 기기에 그대로 있습니다."); return; }
    delete s.envelopes[sk]; await this.save(s, key); await this.refresh("보내려던 요청을 지웠습니다. 서버에 있었다면 함께 철회했습니다.");
  }
}
