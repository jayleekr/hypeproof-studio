// #751 native voluntary help — host adapter. Storage (one file family per record under globalStorageUri, shared by every
// window of this app — classroomHelpStore.ts), fetch and the chat history live here; every decision is in classroomHelp.ts.
// The learning token and the class connection are read fresh for every action, and every answer is checked against them
// again when it comes back: a response that returns after the learner, class or connection changed is never shown to whoever
// is there now.
import * as vscode from "vscode";
import { randomUUID } from "crypto";
import {
  bindingOf, buildContent, classifyPost, cleanDraft, draftKey, emptyDraft, helpDuration, makeEnvelope, requestBody, sendKey, sendable,
  splitShares, turnContent, turnsOf, turnsSince, type Assignment, type Availability, type HelpBinding, type HelpDraft, type HelpEnvelope, type HelpStore, type HelpView, type ShareRecord,
} from "./classroomHelp";
import { HelpRecordStore, type HelpStoreHooks } from "./classroomHelpStore";

/** The pre-2026-09-22 store: the whole help state as one globalState value. Read once, moved to files, then removed. */
const LEGACY_KEY = "hypeproof.classroomHelp.v1";
const SWEEP_EVERY_MS = 10 * 60_000;
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

/** A note is the result of one learner's action. It is drawn only for that learner-in-connection (`for`, null = says nothing
 * about anyone), and one that reports a sent request (`share`) is dropped once that request has moved on (read, answered,
 * resolved, withdrawn or expired), so "보냈습니다" never sits next to an instructor's answer. */
type Note = { text: string; for: string | null; share?: string };

export class ClassroomHelpHost {
  private generation = 0;
  private note: Note | null = null;
  private lastGood = new Map<string, { shares: ShareRecord[]; at: number }>();
  private lastAssignment: { sk: string; a: Assignment } | null = null;
  private busy = false;
  private readonly records: HelpRecordStore;
  private moved: Promise<void> | null = null;
  private lastSweep = 0;
  /** `hooks` is the store's test seam (pause a write at a commit boundary); the app passes none. */
  constructor(private readonly legacy: vscode.Memento, root: string, private readonly deps: HelpHostDeps, hooks?: HelpStoreHooks) { this.records = new HelpRecordStore(root, hooks); }

  /** Moves the old globalState store to files once. Cleared only after every record is on disk; a failure retries next time. */
  private ready(): Promise<void> {
    return (this.moved ??= (async () => {
      const old = this.legacy.get<HelpStore>(LEGACY_KEY);
      if (!old) return;
      const r = old.drafts && old.envelopes ? await this.records.importLegacy(old) : { imported: 0, present: 0, expired: 0, failed: 0 };
      this.deps.log(`[help] legacy store moved: imported=${r.imported} present=${r.present} expired=${r.expired} failed=${r.failed}`);
      if (r.failed) throw new Error("legacy_move_incomplete");
      await this.legacy.update(LEGACY_KEY, undefined);
    })().catch((e) => { this.moved = null; this.deps.log(`[help] legacy store move deferred: ${(e as Error).message}`); }));
  }
  private draftOf(dk: string) { return this.records.get("draft", dk).catch(() => null); }
  private envelopeOf(sk: string) { return this.records.get("envelope", sk).catch(() => null); }
  /**
   * The only ways this adapter writes: one record at a time, compare-and-swap against what that record holds NOW (another
   * window may have written it since this one read it). Returns whether the record changed; false also when the disk refused.
   */
  private async setDraft(dk: string, change: (d: HelpDraft | null) => HelpDraft | null | undefined): Promise<boolean> {
    try { return (await this.records.update("draft", dk, change)).changed; } catch (e) { this.deps.log(`[help] draft not saved: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); return false; }
  }
  private async setEnvelope(sk: string, change: (e: HelpEnvelope | null) => HelpEnvelope | null | undefined): Promise<boolean | "failed"> {
    try { return (await this.records.update("envelope", sk, change)).changed; } catch (e) { this.deps.log(`[help] request record not saved: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); return "failed"; }
  }
  /** Clears the question once the request carrying it was stored — only if the learner has not typed something else since. */
  private clearSent(dk: string, question: string) {
    return this.setDraft(dk, (d) => (d && d.question.trim() === question ? { ...d, question: "", turnId: null, updated_at: Date.now() } : undefined));
  }
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
  /** After any await: is the same learner, in the same class connection, still here? */
  private async still(sk: string): Promise<boolean> { const w = await this.who(); return !!w.binding && sendKey(w.binding) === sk; }
  private async assignment(token: string, consentFor?: { id: string; duration: number }): Promise<Availability> {
    const r = await this.call("help-recipient" + (consentFor ? `?request_id=${encodeURIComponent(consentFor.id)}&duration_minutes=${consentFor.duration}` : ""), token);
    if (r.status === 200 && r.json?.available === true && typeof r.json.recipient_id === "string") return { state: "ready", assignment: r.json as Assignment };
    if (r.status === 200 && typeof r.json?.reason === "string") return { state: "unavailable", reason: r.json.reason };
    // The student gate: a minor cohort (no guardian-consent contract yet) or a learner outside the roster.
    if (r.status === 403 && /sharing unavailable/.test(String(r.json?.error ?? ""))) return { state: "unavailable", reason: "sharing_unavailable" };
    return { state: "unknown" };
  }

  /**
   * Read everything again and draw it. `note` is the result of the learner's last action; `noteFor` is whose it is.
   * Every await is followed by the same question — is this still the newest draw, for the same learner and connection? — and
   * a draw that lost is dropped, not posted: an answer read for learner A can never reach the screen after learner B's.
   */
  async refresh(note?: string | null, noteFor: string | null = null, share?: string): Promise<void> {
    if (note !== undefined) this.note = note === null ? null : { text: note, for: noteFor, ...(share ? { share } : {}) };
    const gen = ++this.generation; await this.ready(); const w = await this.who();
    const live = async (sk: string) => gen === this.generation && (await this.still(sk)) && gen === this.generation;
    const shown = (sk: string | null) => (this.note && (this.note.for === null || this.note.for === sk) ? this.note.text : null);
    if (!w.binding) {
      if (gen !== this.generation) return;
      this.lastAssignment = null; if (this.note?.for) this.note = null;
      this.deps.post({ generation: gen, draft_key: null, availability: { state: "unavailable", reason: w.reason ?? "not_paired" }, seat: null, draft: emptyDraft(), turns: [], envelope: null, current: [], history: [], refresh: { state: "never", at: null }, note: shown(null) });
      return;
    }
    const b = w.binding, dk = draftKey(b), sk = sendKey(b);
    if (this.note?.for && this.note.for !== sk) this.note = null; // a note is never carried to another learner or connection
    if (Date.now() - this.lastSweep > SWEEP_EVERY_MS) { this.lastSweep = Date.now(); await this.records.sweep(dk).catch(() => 0); }
    // The current class is read with the Service's class filter (never cut off by older history); history separately.
    const [availability, cur, all] = await Promise.all([this.assignment(w.token), this.call("shares?session_id=" + encodeURIComponent(b.run), w.token), this.call("shares", w.token)]);
    if (!(await live(sk))) return;
    this.lastAssignment = availability.state === "ready" ? { sk, a: availability.assignment } : null;
    let shares: ShareRecord[] | null = null;
    if (cur.status === 200 && Array.isArray(cur.json?.shares) && all.status === 200 && Array.isArray(all.json?.shares)) {
      const seen = new Set<string>(); shares = [...cur.json.shares, ...all.json.shares].filter((x: ShareRecord) => !seen.has(x.id) && !!seen.add(x.id)) as ShareRecord[];
      this.lastGood.set(dk, { shares, at: Date.now() });
    }
    const good = this.lastGood.get(dk), split = splitShares(good?.shares ?? [], b.run);
    // A request whose answer was lost: if the Service has it, it was stored — the envelope is done. Otherwise it stays unknown.
    const env = await this.envelopeOf(sk);
    if (env && env.state !== "prepared" && shares?.some((s) => s.id === env.request_id)) {
      if ((await this.setEnvelope(sk, (e) => (e?.request_id === env.request_id ? null : undefined))) === true) await this.clearSent(dk, env.content.question ?? "");
      if (!(await live(sk))) return;
      this.note = { text: "보낸 도움 요청이 서버에 저장된 것을 확인했습니다.", for: sk, share: env.request_id };
    }
    // "보냈습니다" belongs to a request still waiting to be opened. Once the Service shows it moved on (or gone), say nothing.
    if (shares && this.note?.share) { const s = shares.find((x) => x.id === this.note!.share); if (!s || s.status !== "received") this.note = null; }
    const [draft, envelope] = await Promise.all([this.draftOf(dk), this.envelopeOf(sk)]);
    if (!(await live(sk))) return;
    const since = turnsSince(this.deps.connection());
    this.deps.post({
      generation: gen, draft_key: dk, availability, seat: b.seat, draft: draft ?? emptyDraft(), turns: turnsOf(this.deps.history(), since),
      envelope, current: split.current, history: split.history,
      refresh: shares ? { state: "ok", at: Date.now() } : { state: good ? "failed" : "never", at: good?.at ?? null }, note: shown(sk),
    });
  }

  /** Keep what the learner typed, for this learner in this class only. Refused if the view was drawn for someone else. */
  async draft(key: string, raw: unknown): Promise<void> {
    await this.ready(); const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key) return;
    const d = cleanDraft(raw, Date.now()); await this.setDraft(key, () => d);
  }

  /** Freeze exactly what would be sent, for this learner, class, connection and recipient. Nothing leaves this device here. */
  async preview(key: string, raw: unknown): Promise<void> {
    await this.ready(); const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key) { await this.refresh("수업 연결이나 참여자가 바뀌어 미리 보기를 만들지 않았습니다."); return; }
    const b = w.binding, sk = sendKey(b), draft = cleanDraft(raw, Date.now()), id = randomUUID();
    await this.setDraft(key, () => draft);
    // The Service signs the end time shown below for this id and duration: that is what the learner consents to.
    const availability = await this.assignment(w.token, { id, duration: helpDuration(draft.duration) });
    if (!(await this.still(sk))) { await this.refresh("수업 연결이나 참여자가 바뀌어 미리 보기를 만들지 않았습니다."); return; }
    if (availability.state !== "ready") { await this.refresh(availability.state === "unknown" ? "받는 강사를 지금 확인할 수 없습니다. 잠시 뒤 다시 시도해 주세요." : null, sk); return; }
    const since = turnsSince(this.deps.connection()), turn = draft.turnId ? turnContent(this.deps.history(), draft.turnId, since) : null;
    if (draft.turnId && !turn) { await this.refresh("고른 대화를 이번 수업 기록에서 찾지 못했습니다. 다시 골라 주세요.", sk); return; }
    const { content, truncated } = buildContent(draft.question, turn);
    if (!Object.keys(content).length) { await this.refresh("질문을 쓰거나 보낼 대화를 하나 골라 주세요.", sk); return; }
    const envelope = makeEnvelope({ binding: b, assignment: availability.assignment, draft, content, truncated, now: Date.now(), id });
    if (!envelope) { await this.refresh("받는 강사를 지금 확인할 수 없습니다. 잠시 뒤 다시 시도해 주세요.", sk); return; }
    // A request that is being sent, or whose answer was lost, is never replaced by a new preview (from this or another window).
    let busy = false;
    const saved = await this.setEnvelope(sk, (cur) => { busy = !!cur && cur.state !== "prepared"; return busy ? undefined : envelope; });
    await this.refresh(busy ? "보낸 요청을 아직 확인하는 중이라 새로 미리 보지 않았습니다." : saved === "failed" ? "이 기기에 미리 보기를 저장하지 못했습니다. 다시 시도해 주세요." : null, sk);
  }
  async cancel(key: string): Promise<void> {
    await this.ready(); const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key) return;
    const sk = sendKey(w.binding);
    // A consented request whose answer is unknown is not silently forgotten: it may exist on the Service.
    await this.setEnvelope(sk, (e) => (e?.state === "prepared" ? null : undefined));
    await this.refresh("보내지 않았습니다. 쓴 질문은 그대로 있습니다.", sk);
  }

  /** The learner ticked consent and pressed send (or retries a request whose answer was lost — same id, same envelope). */
  async send(key: string, requestId: string, consent: boolean): Promise<void> {
    if (this.busy) return; this.busy = true;
    try {
      await this.ready(); const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key) { await this.refresh("수업 연결이나 참여자가 바뀌어 보내지 않았습니다."); return; }
      const b = w.binding, sk = sendKey(b), e = await this.envelopeOf(sk);
      if (!e || e.request_id !== requestId) { await this.refresh("미리 본 내용이 바뀌었습니다. 다시 확인해 주세요.", sk); return; }
      if (e.state === "prepared" && consent !== true) { await this.refresh("동의 확인란을 선택해야 보낼 수 있습니다.", sk); return; }
      const ok = sendable(e, b, this.lastAssignment?.sk === sk ? this.lastAssignment.a : null, Date.now());
      const mine = (x: HelpEnvelope | null): x is HelpEnvelope => x?.request_id === e.request_id;
      if (ok !== "ok") { if (e.state === "prepared") await this.setEnvelope(sk, (x) => (mine(x) && x.state === "prepared" ? null : undefined)); await this.refresh(ok === "stale" ? "동의한 열람 기간이 지났거나 미리 본 지 오래되어 보내지 않았습니다. 다시 확인해 주세요." : "받는 강사나 수업 연결이 바뀌어 보내지 않았습니다. 내용을 다시 확인해 주세요.", sk); return; }
      // Written BEFORE the request leaves: after a crash or a lost answer this device knows a request may exist. Only the
      // envelope the learner consented to is marked; if another window replaced it meanwhile, nothing is sent. If this device
      // cannot record it, nothing is sent either.
      const marked = await this.setEnvelope(sk, (x) => (mine(x) ? { ...x, state: "sending" } : undefined));
      if (marked === "failed") { await this.refresh("이 기기에 보내는 중임을 기록하지 못해 보내지 않았습니다. 다시 시도해 주세요.", sk); return; }
      if (!marked) { await this.refresh("미리 본 내용이 바뀌었습니다. 다시 확인해 주세요.", sk); return; }
      const r = await this.call("shares", w.token, { method: "POST", body: JSON.stringify(requestBody(e)) });
      const verdict = classifyPost(r.status, r.json?.reason);
      // The answer is about THIS request of THIS learner: it is recorded under that learner's own keys (whoever is here now),
      // and only for the same request id — never onto another preview. It is drawn only if that learner is still here.
      const settled = await this.setEnvelope(sk, (x) => (!mine(x) ? undefined : verdict === "stored" ? null : verdict === "unknown" ? { ...x, state: "unknown" } : null));
      if (settled === true && verdict === "stored") await this.clearSent(key, e.content.question ?? "");
      await this.refresh(verdict === "stored" ? "강사에게 보냈습니다. 강사가 답하면 여기에 표시됩니다." : verdict === "unknown" ? "보냈는지 확인하지 못했습니다. ‘다시 확인’을 누르면 같은 요청으로 다시 확인합니다(중복되지 않습니다)." : verdict === "expired" ? "동의한 열람 기간이 이미 지나 보내지 않았습니다. 쓴 질문은 그대로 있으니 다시 미리 보고 동의해 주세요." : verdict === "changed" ? "받는 강사나 수업 연결이 바뀌어 저장되지 않았습니다. 쓴 질문은 그대로 있습니다." : "요청이 받아들여지지 않았습니다. 쓴 질문은 그대로 있습니다.", sk, verdict === "stored" ? e.request_id : undefined);
    } finally { this.busy = false; }
  }

  /** A request whose answer was lost and that the Service does not list is retried with the same id and envelope. */
  async retry(key: string): Promise<void> {
    await this.ready(); const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key) return;
    const sk = sendKey(w.binding), e = await this.envelopeOf(sk); if (!e || e.state === "prepared") return;
    const listed = await this.call("shares?session_id=" + encodeURIComponent(e.class_run_id), w.token);
    if (!(await this.still(sk))) { await this.refresh(); return; }
    if (listed.status === 200 && Array.isArray(listed.json?.shares) && listed.json.shares.some((x: ShareRecord) => x.id === e.request_id)) { await this.refresh(null, sk); return; }
    if (listed.status !== 200) { await this.refresh("지금은 서버에 확인할 수 없습니다. 보낸 요청은 이 기기에 그대로 있습니다.", sk); return; }
    await this.send(key, e.request_id, true);
  }

  async confirm(key: string, id: string, revision: number): Promise<void> {
    const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !Number.isInteger(revision)) return;
    const r = await this.call(`shares/${encodeURIComponent(id)}/confirm`, w.token, { method: "POST", body: JSON.stringify({ expected_revision: revision }) });
    await this.refresh(r.status === 200 ? "해결됐다고 강사에게 알렸습니다." : r.status === 409 ? "그 사이 강사가 답을 고쳤거나 요청이 만료됐습니다. 새로 읽은 내용을 확인해 주세요." : "확인을 보내지 못했습니다. 다시 시도해 주세요.", sendKey(w.binding));
  }
  async withdraw(key: string, id: string): Promise<void> {
    const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return;
    const r = await this.call(`shares/${encodeURIComponent(id)}`, w.token, { method: "DELETE" });
    await this.refresh(r.status === 200 ? "공유를 철회했습니다. 강사는 더 이상 이 내용을 열 수 없습니다." : r.status === 404 ? "이미 철회됐거나 만료된 공유입니다." : "철회하지 못했습니다. 다시 시도해 주세요.", sendKey(w.binding));
  }
  /** A lost-answer request the learner no longer wants: dropped here AND withdrawn on the Service if it exists there. */
  async discard(key: string): Promise<void> {
    await this.ready(); const w = await this.who(); if (!w.binding || draftKey(w.binding) !== key) return;
    const sk = sendKey(w.binding), e = await this.envelopeOf(sk); if (!e) return;
    const r = await this.call(`shares/${encodeURIComponent(e.request_id)}`, w.token, { method: "DELETE" });
    if (r.status !== 200 && r.status !== 404) { await this.refresh("지금은 서버에서 지우지 못했습니다. 요청은 이 기기에 그대로 있습니다.", sk); return; }
    await this.setEnvelope(sk, (x) => (x?.request_id === e.request_id ? null : undefined));
    await this.refresh("보내려던 요청을 지웠습니다. 서버에 있었다면 함께 철회했습니다.", sk);
  }
}
