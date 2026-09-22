// Host adapter for remote classroom operations (#751). VS Code, SecretStorage,
// disk and fetch live here; every decision lives in classroomOps.ts.
//
// The operations credential is separate from the learning token on purpose: it
// can only report this seat's status, and the learner can drop it at any time.
import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { CommandRunner, type Executor, type JournalState } from "./classroomOpsCommands";
import { copyFileNames, freezeCollection, freezeSnapshot, normalizeKinds, uploadSnapshot, WINDOW_LEAD_MS, type CollectKind, type CollectionBinding, type SnapshotBinding, type SnapshotDeps, type SnapshotScope, type SnapshotState } from "./evidenceSnapshot";
import { removeFrozenCopy } from "./evidenceSnapshotStore";
import { resetPostcondition, runPreservingReset, stopAndConfirm, type Preservation, type ResetManifest, type ResetSteps } from "./runtimeReset";
import {
  ChangeGate, OPS_CLIENT_CAPABILITIES, OPS_PROTOCOL, OpsOutbox, activationPayload, classifyFailure, errorPayload,
  evidencePayload, runtimePayload, stepPayload, turnObservations, uploadPayload, startOpsSync, tokenIdentityUnverified,
  RECOVERY_FOLLOWUP_CAPABILITY, RecoveryWatch, profileCheckClears, recoveryPayload, turnFailureClass, type OpsSyncLoop, type OutboxState, type RuntimeStatus, type SyncResponse,
} from "./classroomOps";
import { INBOX_CAPABILITY, INBOX_PROMPT_CAPABILITY, LESSON_BINDING_CAPABILITY, boundSetting, emptyView, inboxPresence, markSettingBound, mayHideInbox, pendingSetting, pointerIsStale, type InboxView, type LessonRef } from "./classroomInbox";
import { InboxSession, InboxStore, inboxDir, inboxView } from "./classroomInboxStore";

const CREDENTIAL_KEY = "hypeproof.classroomOps.credential";
const META_KEY = "hypeproof.classroomOps.connection";
/**
 * Which inbox the learner is shown: the one of the connection that is valid now, or of the last one that ended the
 * normal way (class over). Kept apart from META_KEY because that one is forgotten when a class ends, and material the
 * learner already received must stay readable after it. `hidden` = the Service closed that connection for good
 * (revoked, seat re-assigned, replaced by another device): this device can no longer be told about a withdrawal, so it
 * stops showing the instructor's text. Nothing is deleted.
 */
const INBOX_KEY = "hypeproof.classroomOps.inbox";
/** `ends_at`/`expired` are the only things that let this device SAY a class ended; without them a missing connection is just that. */
/**
 * `grant` = the connection that owns this pointer. globalState and the inbox directory are shared by every WINDOW of this app,
 * so "this connection was closed for good" may only hide the inbox while the pointer still belongs to that connection. A
 * window whose connection was replaced by the same learner's newer connection (a second window paired with a new code) must
 * not hide what the newer connection legitimately shows — observed on the real Mac: the board said "보관함 반영" while
 * neither window drew the inbox, because the replaced window had marked the shared pointer hidden.
 */
interface InboxPointer { cohort: string; run: string; seat: string; student: string; hidden: boolean; ends_at?: number; expired?: boolean; grant?: string }
/** `student`/`run`/`lesson` come from the Service's connect response: they are what a collected snapshot is bound to. */
interface ConnectionMeta { grant_id: string; class_run_id: string; seat_id: string; expires_at: number; poll_after_ms: number; connected_at?: number; student?: { u: string; c: string; p: string }; run?: { starts_at: number; ends_at: number }; lesson?: { course_id: string; version: string } | null }
/** After its normal expiry a connection can only finish an upload that was already authorized, for this long after class. */
const UPLOAD_GRACE_MS = 24 * 3_600_000;
const FINAL_CREDENTIAL_REFUSALS = ["ops_credential_invalid", "ops_grant_revoked", "ops_grant_expired"];

/** The only things a remote command may touch. No shell, no file access, no history, no arbitrary VS Code command. */
export interface ClassroomOpsActions {
  hasActiveRun(): boolean;
  /** Re-verify the stored learning token against the Service without changing panel state. */
  probeProfile(): Promise<{ ok: boolean; status?: number; code?: string; requestId?: string; network?: boolean; noToken?: boolean }>;
  refreshProfile(): Promise<boolean>;
  /**
   * U4 — `artifact` is about the page the learner actually had open, not the server: "opened" = it answered 2xx with a document,
   * "missing" = the server is up and the page is not there (a 404 is not a recovery), "unreachable" = nothing answered.
   * `tabs` = what the learner's OWN preview tabs (those on the server as it was before) reported afterwards: "loaded" = every
   * one loaded its page anew at the running address, "not_loaded" = not all did, "none" = the learner had none open.
   */
  recoverPreview(): Promise<{ state: "no_preview" | "reloaded" | "restarted"; artifact: "opened" | "missing" | "unreachable"; tabs: "loaded" | "not_loaded" | "none" }>;
  // R3 — stop / preserving reset / pause. Nothing here can clear history or delete a file.
  requestStop(): void;
  freezeInput(frozen: boolean): Promise<void>;
  preservation(): Promise<Preservation>;
  runtimeGeneration(): number;
  newGeneration(): Promise<number>;
  setHold(hold: "paused" | "stop_unconfirmed" | null): void;
  // R4 — allowlisted spool files of the current session, read-only.
  /** The current spool session's files with its sequence state, read under the spool's write queue. `sinceMs` = start of the class window. */
  readSpool(sinceMs: number): Promise<import("./sessionSpool").SpoolSnapshotSource | null>;
  /** #751 U1b — this learner's sessions in the class window (current + restarted/sealed ones). Absent in older hosts: a kinds collection then records nothing. */
  readCollection?(sinceMs: number, identity: { u: string; c: string; p: string }): Promise<import("./sessionSpool").SpoolCollectionSource | null>;
}

/** What the chat provider is allowed to tell this adapter. No message text, no paths. */
export interface ClassroomOpsObserver {
  profileResult(r: { ok: boolean; status?: number; code?: string; requestId?: string; network?: boolean }, token: string): void;
  traceResult(status: number): void;
  /** A turn finished in the real runtime path. No text, only what happened. */
  turnResult(t: import("./classroomOps").TurnOutcome): void;
  /** The learner's own, explicit step action in the lesson panel. Never inferred from chat volume or an AI "done". */
  lessonStep(lessonVersion: string, stepId: string, status: "in_progress" | "submitted"): void;
  /** A real change to the learner's artifact, as digests only. */
  artifactChanged(before: string | undefined, after: string, stepId?: string): void;
}

export class ClassroomOpsHost implements ClassroomOpsObserver {
  private loop: OpsSyncLoop | null = null;
  private outbox: OpsOutbox | null = null;
  private readonly appInstanceId = randomUUID();
  private readonly runtimeGate = new ChangeGate<RuntimeStatus>();
  private readonly activationGate = new ChangeGate<string>();
  private readonly errorGate = new ChangeGate<string>();
  private readonly context: vscode.ExtensionContext;
  private readonly runtime: () => { idleMs: number; status: RuntimeStatus };
  private readonly log: (line: string) => void;
  private readonly actions: ClassroomOpsActions;
  private epoch = 0;
  private token = "";
  /** U4 — armed by a stop / preserving restart, answered once by the learner's next finished turn. */
  private readonly recoveryWatch = new RecoveryWatch();
  /** The class of the fault this connection last reported, so a token re-check clears only what it can actually disprove. */
  private faultClass: string | null = null;
  private followup(payload: ReturnType<typeof recoveryPayload>): void { void this.outbox?.add("recovery", payload); this.loop?.nudge(); }

  constructor(context: vscode.ExtensionContext, runtime: () => { idleMs: number; status: RuntimeStatus }, actions: ClassroomOpsActions, log: (line: string) => void) {
    this.context = context; this.runtime = runtime; this.actions = actions; this.log = log;
    // Another window of this learner may have received, withdrawn or re-pointed the shared inbox while this one was in the
    // background. Coming back to a window re-reads it from disk (a read; nothing is reported, no "opened" is recorded).
    const onFocus = (vscode.window as { onDidChangeWindowState?: (l: (s: { focused: boolean }) => void) => vscode.Disposable }).onDidChangeWindowState;
    if (onFocus) context.subscriptions.push(onFocus.call(vscode.window, (s) => { if (s.focused) this.inboxChanged(false); }));
  }

  /** Kept in memory for this window so the learner can come back to it; never written into their files or chat. */
  private readonly coachingNotes: Array<{ at: number; title: string; text: string }> = [];
  /** A toast, not a modal: it never takes focus from the work and can be dismissed or read later. */
  private showCoaching(title: string, text: string): void {
    this.coachingNotes.unshift({ at: Date.now(), title, text }); this.coachingNotes.length = Math.min(this.coachingNotes.length, 50);
    void vscode.window.showInformationMessage(`${title}: ${text}`, "나중에 보기");
  }
  async showCoachingNotes(): Promise<void> {
    if (!this.coachingNotes.length) { void vscode.window.showInformationMessage("강사가 보낸 질문이나 확인 지점이 없습니다."); return; }
    await vscode.window.showQuickPick(this.coachingNotes.map((n) => ({ label: n.title, detail: n.text, description: new Date(n.at).toLocaleTimeString() })), { title: "강사가 보낸 질문·확인 지점", placeHolder: "읽기만 합니다. 답을 대신 써 주지 않습니다." });
  }
  private credential = "";
  private meta: ConnectionMeta | null = null;
  /** Bumped on every connect, disconnect and expiry. A callback that captured an older value belongs to a connection that is gone. */
  private generation = 0;
  /** #751 U1b — the connection a learner's approval question was asked under ('' = none). Any connect, disconnect or expiry changes it. */
  approvalScope(): string { const m = this.meta; return m ? `${this.generation}:${m.grant_id}:${m.class_run_id}:${m.seat_id}` : ""; }
  /** Shows the learner's approval button in the chat panel title and on index.html only while connected to a class. */
  private connectedContext(on: boolean): void { void vscode.commands.executeCommand("setContext", "hypeproof-chat.classroomConnected", on); }
  private runner: CommandRunner | null = null;
  private scope(): SnapshotScope | null {
    const m = this.meta; if (!m?.student || !m.run) return null; // a connection made before the binding contract cannot collect
    return { grant_id: m.grant_id, class_run_id: m.class_run_id, seat_id: m.seat_id, student: m.student, activity: m.lesson ? { course_id: m.lesson.course_id, version: m.lesson.version } : null, run: m.run };
  }
  private snapshotDeps(consent: { purpose: string; notice_version: string } | null = null, kinds: CollectKind[] | null = null): SnapshotDeps {
    const dir = path.join(this.context.globalStorageUri.fsPath, "classroom-snapshots"), safe = (s: string) => s.replace(/[^A-Za-z0-9-]/g, "");
    const stateFile = (b: string) => path.join(dir, `${safe(b)}.state.json`), copyDir = (b: string, r: number) => path.join(dir, safe(b), `r${r}`);
    const call = async (url: string, init: RequestInit) => { try { const res = await fetch(`${this.base()}/classroom/ops/collect/${url}`, { ...init, signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${this.credential}`, ...(init.headers ?? {}) } }); const j = (await res.json().catch(() => ({}))) as Record<string, string>; return { status: res.status, reason: j.reason, receipt_id: j.receipt_id, coverage: j.coverage, coverage_reason: j.coverage_reason }; } catch { return { status: 0 }; } };
    return {
      scope: () => this.scope(),
      // The immutable copy: written once per (batch, revision) and only ever read back afterwards — with the binding it was frozen under.
      copy: async (b, r) => {
        const target = copyDir(b, r), bindingFile = path.join(target, "binding.json");
        try {
          // A /3 copy (U1b) carries its parts in the binding; the file list is derived from it, never from what else is in the directory.
          const held = JSON.parse(await fs.readFile(bindingFile, "utf8")) as SnapshotBinding | CollectionBinding, copy = "parts" in held ? { collection: held } : { binding: held };
          const files = await Promise.all(copyFileNames(copy).map(async (name) => ({ name, data: new Uint8Array(await fs.readFile(path.join(target, name))) })));
          return { files, ...copy };
        } catch { /* not copied yet */ }
        // Resuming never reads the live spool: without the frozen copy and an explicit consent scope there is nothing to send.
        const scope = this.scope(); if (!scope || !consent) return null;
        let frozen: { ok: true; files: Array<{ name: string; data: Uint8Array }>; binding?: SnapshotBinding; collection?: CollectionBinding } | { ok: false; code: string };
        if (kinds) {
          // U1b — the asked kinds, over this learner's sessions in the window. Earlier sessions are read from disk by name and identity only.
          const src = this.actions.readCollection ? await this.actions.readCollection(scope.run.starts_at - WINDOW_LEAD_MS, scope.student) : null; if (!src) return null;
          const fc = freezeCollection(src, scope, b, consent, kinds, Date.now()); frozen = fc.ok ? { ok: true, files: fc.files, collection: fc.binding } : fc;
        } else {
          const live = await this.actions.readSpool(scope.run.starts_at - WINDOW_LEAD_MS); if (!live) return null;
          frozen = freezeSnapshot(live.files, scope, b, consent, Date.now(), live);
        }
        if (!frozen.ok) return { code: frozen.code };
        await fs.mkdir(target, { recursive: true });
        for (const f of frozen.files) await fs.writeFile(path.join(target, f.name), f.data, { flag: "wx" });
        await fs.writeFile(bindingFile, JSON.stringify(frozen.collection ?? frozen.binding), { flag: "wx" });
        return { files: frozen.files, ...(frozen.collection ? { collection: frozen.collection } : { binding: frozen.binding }) };
      },
      loadState: async (b) => { try { return JSON.parse(await fs.readFile(stateFile(b), "utf8")) as SnapshotState; } catch { return null; } },
      saveState: async (st) => { await fs.mkdir(dir, { recursive: true }); const tmp = `${stateFile(st.batch_id)}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(st), "utf8"); await fs.rename(tmp, stateFile(st.batch_id)); },
      put: (b, r, name, data) => call(`snapshots/${safe(b)}/${r}/${name}`, { method: "PUT", body: data }),
      seal: (b, r, manifest) => call(`snapshots/${safe(b)}/${r}/seal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest) }),
    };
  }
  private async pendingStates(): Promise<SnapshotState[]> {
    const dir = path.join(this.context.globalStorageUri.fsPath, "classroom-snapshots"), out: SnapshotState[] = [];
    let names: string[] = []; try { names = await fs.readdir(dir); } catch { return out; }
    for (const n of names.filter((x) => x.endsWith(".state.json"))) { try { const st = JSON.parse(await fs.readFile(path.join(dir, n), "utf8")) as SnapshotState; if (!st.receipt_id && !st.result) out.push(st); } catch { /* unreadable state is not work */ } }
    return out;
  }
  /**
   * Uploads that were cut off (offline, laptop closed) are finished from their frozen copy — only those frozen under THIS
   * grant. A copy left by another learner on a shared PC, or by a replaced seat, is never walked with this credential.
   */
  private async resumePendingUploads(): Promise<void> {
    const gen = this.generation, grant = this.meta?.grant_id;
    for (const st of await this.pendingStates()) {
      if (gen !== this.generation || !grant || st.scope?.grant_id !== grant) continue;
      try {
        const r = await uploadSnapshot(st.batch_id, this.snapshotDeps());
        // The Service says this credential is finished (revoked, seat replaced, window closed): stop, and drop it.
        if (FINAL_CREDENTIAL_REFUSALS.includes(r.code) && gen === this.generation) { await this.forget(); return; }
      } catch { /* next start tries again */ }
    }
  }
  /** Withdrawal ends collection on this device too: the frozen copies made for this connection are removed, not kept "just in case". */
  private async dropPendingCopies(result: string): Promise<void> {
    const dir = path.join(this.context.globalStorageUri.fsPath, "classroom-snapshots"), grant = this.meta?.grant_id, deps = this.snapshotDeps();
    for (const st of await this.pendingStates()) {
      if (!grant || st.scope?.grant_id !== grant) continue;
      await deps.saveState({ ...st, result });
      await removeFrozenCopy(dir, st.batch_id);
    }
  }
  /** Adult learners decide for themselves, after reading what is sent and to whom. A child class needs a guardian consent recorded by the operator. */
  async collectionConsentInteractively(): Promise<void> {
    if (!this.credential) { void vscode.window.showInformationMessage("먼저 ‘수업 연결’로 이번 수업에 연결하세요."); return; }
    const pick = await vscode.window.showInformationMessage("이번 수업의 기록(내 질문·AI 응답·작업 이벤트)을 수업 보고서 작성 목적으로 운영자에게 보낼까요? 강사 화면에는 원문이 보이지 않으며, 보낸 뒤에도 같은 메뉴에서 철회할 수 있습니다. 이미 전달된 사본은 회수할 수 없습니다.", { modal: true }, "동의하고 보내기 허용", "동의 철회");
    if (!pick) return;
    const res = await fetch(`${this.base()}/classroom/ops/collect/consent`, { method: "POST", headers: { authorization: `Bearer ${this.credential}`, "content-type": "application/json" }, body: JSON.stringify({ consent: pick === "동의하고 보내기 허용", purpose: "class_report", notice_version: "notice-v1" }), signal: AbortSignal.timeout(10000) }).catch(() => null);
    const reason = res && !res.ok ? ((await res.json().catch(() => ({}))) as { reason?: string }).reason : "";
    if (res?.ok && pick === "동의 철회") await this.dropPendingCopies("withdrawn");
    void vscode.window.showInformationMessage(!res ? "서버에 연결하지 못했습니다. 동의 상태는 바뀌지 않았습니다." : res.ok ? (pick === "동의 철회" ? "동의를 철회했습니다. 이 수업의 기록은 더 수집되지 않습니다." : "동의를 기록했습니다.") : reason === "guardian_consent_required" ? "이 수업은 보호자 동의가 필요합니다. 앱에서 직접 동의할 수 없습니다." : reason === "ops_collect_disabled" ? "이 수업은 기록 수집을 사용하지 않습니다." : "동의를 기록하지 못했습니다.");
  }
  private stopUnconfirmed = false;
  private paused = false;
  private controlRevision = 0;
  private applyHold(): void { this.actions.setHold(this.stopUnconfirmed ? "stop_unconfirmed" : this.paused ? "paused" : null); }
  private manifestFile(commandId: string): string { return path.join(this.context.globalStorageUri.fsPath, `classroom-ops-reset-${commandId.replace(/[^A-Za-z0-9-]/g, "")}.json`); }
  private async readManifest(commandId: string): Promise<ResetManifest | null> { try { return JSON.parse(await fs.readFile(this.manifestFile(commandId), "utf8")) as ResetManifest; } catch { return null; } }
  private resetSteps(commandId: string): ResetSteps {
    const file = this.manifestFile(commandId);
    return {
      freezeInput: () => this.actions.freezeInput(true), unfreezeInput: () => this.actions.freezeInput(false),
      requestStop: () => this.actions.requestStop(), isStopped: () => !this.actions.hasActiveRun(),
      preserve: () => this.actions.preservation(), generation: () => this.actions.runtimeGeneration(),
      persistManifest: async (m) => { const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(m), "utf8"); await fs.rename(tmp, file); },
      newGeneration: () => this.actions.newGeneration(), probe: () => this.actions.refreshProfile(),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(),
    };
  }

  /** R2 low-risk set. Each is read-only or re-connects something that already exists. */
  private executors(): Record<string, Executor> {
    return {
      retry_diagnostics: { mutating: false, run: async () => {
        let reachable = false;
        try { reachable = (await fetch(`${this.base()}/health`, { signal: AbortSignal.timeout(4000) })).ok; } catch { reachable = false; }
        if (!reachable) return { ok: true, code: "service_unreachable" };
        const p = await this.actions.probeProfile();
        if (p.noToken) return { ok: true, code: "no_token" };
        this.profileResult(p, this.token);
        return { ok: true, code: p.ok ? "token_ok" : p.network ? "profile_network" : `profile_${p.status ?? 0}` };
      } },
      refresh_connection: { mutating: false, run: async (_s, command) => {
        // Never under a running turn: a refresh must not disturb work in progress.
        if (this.actions.hasActiveRun()) return { ok: false, code: "busy_active_run" };
        if (!(await this.actions.refreshProfile())) return { ok: false, code: "profile_not_verified" };
        // U4 — WHICH issue was verified is the whole answer after a re-issue: the old token still validating is not the new one
        // arriving. The public issue id of the token this app holds now goes with the command id; the token never does.
        this.followup(recoveryPayload(command.command_id, "profile_verified", { tokenJti: tokenIdentityUnverified(this.token).jti }));
        return { ok: true, code: "profile_verified" };
      } },
      cancel_current_run: { mutating: true, label: "지금 실행 중인 작업 멈추기", run: async (_s, command) => {
        if (!this.actions.hasActiveRun()) return { ok: true, code: "no_active_run" };
        // U4 — the baseline is taken BEFORE the stop and compared after it. Two readings of the same moment would always agree.
        let before: Preservation | null = null; try { before = await this.actions.preservation(); } catch { before = null; }
        const stopped = await stopAndConfirm({ requestStop: () => this.actions.requestStop(), isStopped: () => !this.actions.hasActiveRun(), wait: (ms) => new Promise((r) => setTimeout(r, ms)) });
        // An unconfirmed stop holds NEW runs only. What already happened outside is not undone, and is not claimed to be.
        this.stopUnconfirmed = !stopped; this.applyHold();
        if (!stopped) return { ok: false, code: "stop_unconfirmed" };
        // The unsent draft (text, attachments, queued input) is byte-identical and the conversation did not get shorter.
        let kept = false; try { const after = await this.actions.preservation(); kept = !!before && after.draft_sha256 === before.draft_sha256 && after.history_count >= before.history_count; } catch { kept = false; }
        if (!kept) return { ok: false, code: "preservation_mismatch" };
        this.recoveryWatch.arm(command.command_id, this.epoch);
        return { ok: true, code: "run_stopped" };
      } },
      reset_runtime: { mutating: true, label: "AI 세션 다시 시작 (대화와 파일은 그대로)",
        run: async (signal, command) => {
          const r = await runPreservingReset(command.command_id, this.resetSteps(command.command_id), signal);
          if (r.code === "stop_unconfirmed") { this.stopUnconfirmed = true; this.applyHold(); }
          if (r.ok) { this.stopUnconfirmed = false; this.applyHold(); this.recoveryWatch.arm(command.command_id, this.epoch); }
          return r;
        },
        postcondition: async (command) => resetPostcondition(await this.readManifest(command.command_id), this.actions.runtimeGeneration()),
      },
      // R4 — issued by the Service as part of a collection batch the learner consented to. Reads the spool; changes nothing.
      // U1b — `kinds` (with `sessions: "window"`) asks for those kinds over every session of this learner in the class window.
      retry_evidence_upload: { mutating: false, acceptsArgs: (a) => typeof a.batch_id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(a.batch_id) && Object.keys(a).every((k) => ["batch_id", "purpose", "notice_version", "kinds", "sessions"].includes(k)) && (a.kinds === undefined ? a.sessions === undefined : !!normalizeKinds(a.kinds) && a.sessions === "window"),
        run: async (_s, command) => { const kinds = command.args.kinds === undefined ? null : normalizeKinds(command.args.kinds); const r = await uploadSnapshot(String(command.args.batch_id), this.snapshotDeps({ purpose: String(command.args.purpose ?? ""), notice_version: String(command.args.notice_version ?? "") }, kinds)); void this.outbox?.add("upload", uploadPayload(r.ok ? "verified" : r.code === "offline_pending" ? "pending" : "failed")); return r; } },
      // Coaching: a question or a pointer, shown without covering the work. Nothing on disk or in the conversation changes.
      send_question: { mutating: false, acceptsArgs: (a) => Object.keys(a).join() === "text" && typeof a.text === "string" && a.text.length <= 300,
        run: async (_s, command) => { this.showCoaching("강사의 질문", String(command.args.text)); return { ok: true, code: "shown" }; } },
      mark_checkpoint: { mutating: false, acceptsArgs: (a) => Object.keys(a).every((k) => k === "step_id" || k === "note") && Object.values(a).every((v) => typeof v === "string" && v.length <= 200),
        run: async (_s, command) => { this.showCoaching("강사가 다시 보라고 표시한 지점", [command.args.step_id ? `단계 ${command.args.step_id}` : "", command.args.note ?? ""].filter(Boolean).join(" · ") || "현재 작업"); return { ok: true, code: "shown" }; } },
      restart_preview: { mutating: false, run: async () => {
        const r = await this.actions.recoverPreview();
        if (r.state === "no_preview") return { ok: false, code: "no_preview" };
        // U4 — the server answering is not the learner's page opening. A 404 is a fault with its own name, and a restart whose
        // tab still points at the dead address is not a recovery until that tab is re-pointed (or the learner is asked to).
        if (r.artifact === "missing") return { ok: false, code: "preview_artifact_missing" };
        if (r.artifact !== "opened") return { ok: false, code: "preview_unhealthy" };
        // Only the learner's own tab having loaded the page counts as the page being back. Without one, a healthy server is
        // all that was seen (the learner may have no preview open), and a restart left them nothing on the new address.
        if (r.state === "reloaded") return { ok: true, code: r.tabs === "loaded" ? "preview_artifact_ok" : "preview_reloaded" };
        return r.tabs === "loaded" ? { ok: true, code: "preview_reopened_artifact_ok" } : { ok: false, code: "preview_restarted_new_url" };
      } },
    };
  }

  private base(): string {
    return vscode.workspace.getConfiguration("hypeproofChat").get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1").replace(/\/$/, "");
  }
  private version(): string {
    const v = this.context.extension?.packageJSON?.version; return typeof v === "string" ? v : "";
  }

  /** Resume a stored connection after a restart. Silent when there is none or the Service has no such feature. */
  async resume(): Promise<void> {
    const meta = this.context.globalState.get<ConnectionMeta>(META_KEY);
    const credential = await this.context.secrets.get(CREDENTIAL_KEY);
    if (!meta || !credential) return;
    if (meta.expires_at <= Date.now()) { await this.resumeUploadOnly(meta, credential); return; }
    await this.start(meta, credential);
  }

  /**
   * The connection expired the normal way (class over). Observation, commands and the instructor's pause do NOT come
   * back. The credential is kept for one thing only: finishing a snapshot the learner already agreed to send and this
   * device already froze, inside the Service's upload window. After that, or when the Service refuses it, it is dropped.
   */
  private async resumeUploadOnly(meta: ConnectionMeta, credential: string): Promise<void> {
    const until = Math.max(meta.run?.ends_at ?? 0, meta.expires_at) + UPLOAD_GRACE_MS;
    this.meta = meta; this.generation++;
    const mine = (await this.pendingStates()).filter((st) => st.scope?.grant_id === meta.grant_id);
    if (Date.now() > until || !mine.length) { await this.forget(); return; }
    this.credential = credential;
    void this.resumePendingUploads().then(async () => { if (!(await this.pendingStates()).some((st) => st.scope?.grant_id === meta.grant_id && this.meta?.grant_id === meta.grant_id)) await this.forget(); });
  }

  /** Learner-initiated: type the one-time code the instructor handed over. */
  async connectInteractively(): Promise<void> {
    const ticket = await vscode.window.showInputBox({
      title: "수업 연결", prompt: "강사가 알려준 수업 연결 코드를 입력하세요 (10분 안에 한 번만 쓸 수 있습니다)",
      placeHolder: "XXXX-XXXX-XXXX", ignoreFocusOut: true, validateInput: (v) => (v.replace(/[^0-9A-Za-z]/g, "").length === 12 ? null : "12자리 코드를 입력하세요"),
    });
    if (!ticket) return;
    let res: Response;
    try {
      res = await fetch(`${this.base()}/classroom/ops/connect`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ ticket, app_instance_id: this.appInstanceId, boot_id: randomUUID(), protocol: OPS_PROTOCOL, capabilities: [...OPS_CLIENT_CAPABILITIES, RECOVERY_FOLLOWUP_CAPABILITY, "commands", ...Object.keys(this.executors()), INBOX_CAPABILITY], app_version: this.version() }),
      });
    } catch {
      void vscode.window.showWarningMessage("서버에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 같은 코드로 다시 시도하세요."); return;
    }
    if (res.status === 404) { void vscode.window.showInformationMessage("이 수업 서버에는 수업 연결 기능이 켜져 있지 않습니다. 수업 참여에는 영향이 없습니다."); return; }
    if (res.status === 429) { void vscode.window.showWarningMessage("연결 시도가 너무 많습니다. 1분 뒤 다시 시도하세요."); return; }
    if (res.status !== 201) { void vscode.window.showWarningMessage("연결 코드가 맞지 않거나 이미 사용됐거나 시간이 지났습니다. 강사에게 새 코드를 요청하세요."); return; }
    const b = (await res.json()) as ConnectionMeta & { credential: string };
    // A new pairing replaces whatever this window was connected to; responses still in flight for it are void.
    this.stopConnection();
    await this.context.secrets.store(CREDENTIAL_KEY, b.credential);
    const meta: ConnectionMeta = { grant_id: b.grant_id, class_run_id: b.class_run_id, seat_id: b.seat_id, expires_at: b.expires_at, poll_after_ms: b.poll_after_ms, connected_at: Date.now(), ...(b.student ? { student: b.student } : {}), ...(b.run ? { run: b.run } : {}), lesson: b.lesson ? { course_id: b.lesson.course_id, version: b.lesson.version } : null };
    await this.context.globalState.update(META_KEY, meta);
    await this.start(meta, b.credential);
    void vscode.window.showInformationMessage(
      `수업에 연결했습니다 (좌석 ${b.seat_id}). 강사 화면에는 입장·단계·오류 상태만 보입니다. 대화 내용과 파일은 보내지 않으며, 이 연결로는 AI를 쓸 수 없습니다. 명령 팔레트의 ‘수업 연결 끊기’로 언제든 끊을 수 있습니다.`,
    );
  }

  /** #751 native help — this window's LIVE class connection: whose seat, which class, which grant. Never the credential. */
  helpConnection(): { grant_id: string; class_run_id: string; seat_id: string; connected_at?: number; student?: { u: string; c: string; p: string }; run?: { starts_at: number; ends_at: number } } | null {
    const m = this.meta; if (!m || !this.loop || !this.credential) return null;
    return { grant_id: m.grant_id, class_run_id: m.class_run_id, seat_id: m.seat_id, ...(m.connected_at ? { connected_at: m.connected_at } : {}), ...(m.student ? { student: m.student } : {}), ...(m.run ? { run: m.run } : {}) };
  }

  async disconnectInteractively(): Promise<void> {
    await this.forget();
    void vscode.window.showInformationMessage("수업 연결을 끊었습니다. 수업 참여와 작업 파일은 그대로입니다.");
  }

  // ── U2 inbox: what the two learner surfaces read ──
  private inbox: InboxSession | null = null;
  private inboxStore: InboxStore | null = null;
  private readonly inboxListeners = new Set<(view: InboxView, fresh: boolean) => void>();
  /** `fresh` = a card just arrived or changed (the surfaces may say so once); false = state refresh only. */
  onInboxChanged(listener: (view: InboxView, fresh: boolean) => void): vscode.Disposable { this.inboxListeners.add(listener); return { dispose: () => this.inboxListeners.delete(listener) }; }
  private inboxChanged(fresh: boolean): void {
    void this.inboxView().then((view) => {
      for (const l of this.inboxListeners) l(view, fresh);
      // A convenience, never evidence: whether this shows, fails or is dismissed changes nothing that is reported.
      if (fresh && view.unread) void vscode.window.showInformationMessage("강사가 자료를 보냈습니다. 작업 화면의 ‘강사가 보낸 공지·자료’에서 볼 수 있습니다.");
    }).catch(() => undefined);
  }
  /**
   * Always answered from disk, through the same read path that decided "reflected". Empty unless the learner whose token
   * this device verified is the learner the inbox belongs to — a shared PC's next user sees nothing of the previous one.
   */
  async inboxView(): Promise<InboxView> {
    const gen = this.generation, me = tokenIdentityUnverified(this.token); let p = this.context.globalState.get<InboxPointer>(INBOX_KEY);
    // This window's own LIVE connection decides for its own learner, whatever another window wrote into the shared pointer
    // (a stale "hidden" of the connection this one replaced). The pointer is repaired so that the other windows follow.
    const live = this.meta?.student && this.loop && this.inboxStore ? this.meta : null;
    if (live && live.student && me.u === live.student.u && me.c === live.student.c && pointerIsStale(p, { grant: live.grant_id, run: live.class_run_id, seat: live.seat_id, student: live.student.u })) {
      p = { cohort: live.student.c, run: live.class_run_id, seat: live.seat_id, student: live.student.u, hidden: false, ends_at: live.run?.ends_at ?? live.expires_at, grant: live.grant_id };
      void this.context.globalState.update(INBOX_KEY, p);
    }
    if (!p || p.hidden || !me.u || me.u !== p.student || me.c !== p.cohort) return emptyView(gen);
    const connected = !!this.meta && this.meta.class_run_id === p.run && this.meta.seat_id === p.seat;
    const presence = inboxPresence({ connected, expired: p.expired === true, ends_at: p.ends_at ?? 0, now: Date.now() });
    try { return await inboxView(new InboxStore(inboxDir(this.context.globalStorageUri.fsPath, p)), { run: p.run, student: p.student, generation: gen, ...presence }); }
    catch (err) { this.log(`[inbox] read: ${(err as Error).message}`); return emptyView(gen); }
  }
  /** A callback from a renderer names the generation it was drawn under; one from an ended connection changes nothing. */
  async inboxOpened(objectId: string, generation: number): Promise<void> {
    if (generation !== this.generation || !/^[A-Za-z0-9-]{8,64}$/.test(objectId)) return;
    const p = this.context.globalState.get<InboxPointer>(INBOX_KEY); if (!p || p.hidden) return;
    const session = this.inbox ?? new InboxSession({ store: new InboxStore(inboxDir(this.context.globalStorageUri.fsPath, p)), alive: () => true, clock: { mono: () => performance.now(), wall: () => Date.now() } });
    await session.markOpened(objectId).catch(() => undefined); this.inboxChanged(false);
  }
  /** Only a link that is in a card this learner can see right now, and only https. Returns the URL to open, or null. */
  async inboxLink(objectId: string, url: string, generation: number): Promise<string | null> {
    if (generation !== this.generation) return null;
    const card = (await this.inboxView()).cards.find((c) => c.object_id === objectId && !c.withdrawn);
    return card?.links.some((l) => l.url === url) && /^https:\/\//i.test(url) ? url : null;
  }
  private async inboxExpired(): Promise<void> {
    const p = this.context.globalState.get<InboxPointer>(INBOX_KEY); if (!p || p.hidden || p.expired) return;
    await this.context.globalState.update(INBOX_KEY, { ...p, expired: true }); this.inboxChanged(false);
  }
  /** Only the connection that owns the pointer hides it. A pointer written by a newer connection (another window) is left alone. */
  private async hideInbox(grantId: string): Promise<void> {
    const p = this.context.globalState.get<InboxPointer>(INBOX_KEY); if (!p || p.hidden) return;
    if (!mayHideInbox(p, grantId)) { this.inboxChanged(false); return; }
    await this.context.globalState.update(INBOX_KEY, { ...p, hidden: true }); this.inboxChanged(false);
  }

  /** End the current connection in this window: no late response, queued approval or pause may act after this line. */
  private stopConnection(): void {
    this.generation++; this.inbox = null; this.inboxStore = null;
    this.loop?.stop(); this.runner?.close(); this.loop = null; this.runner = null; this.outbox = null;
    // Disconnecting ends the instructor's pause on this device; the Service's own admission still applies.
    this.paused = false; this.stopUnconfirmed = false; this.applyHold();
    this.recoveryWatch.clear(); this.faultClass = null;
  }
  private async forget(): Promise<void> {
    const mine = this.meta?.grant_id, was = this.credential;
    this.stopConnection(); this.credential = ""; this.meta = null; this.connectedContext(false);
    // Secrets and globalState are shared between windows where the OS keychain backs them: a window that was replaced must not
    // delete the connection the replacing window has just stored. (Keychain sharing itself was not run — see the test record.)
    const stored = this.context.globalState.get<ConnectionMeta>(META_KEY);
    if (stored && mine && stored.grant_id !== mine) { this.inboxChanged(false); return; }
    if (!was || (await this.context.secrets.get(CREDENTIAL_KEY)) === was) await this.context.secrets.delete(CREDENTIAL_KEY);
    await this.context.globalState.update(META_KEY, undefined);
    this.inboxChanged(false);
  }

  private async start(meta: ConnectionMeta, credential: string): Promise<void> {
    this.stopConnection();
    const gen = this.generation, live = () => gen === this.generation;
    this.credential = credential; this.meta = meta; void this.resumePendingUploads(); this.connectedContext(true);
    const dir = this.context.globalStorageUri.fsPath; await fs.mkdir(dir, { recursive: true });
    // One file per grant: a shared PC's next learner never inherits the previous seat's queue.
    const file = path.join(dir, `classroom-ops-outbox-${meta.grant_id}.json`);
    this.outbox = await OpsOutbox.open({
      load: async () => { try { return JSON.parse(await fs.readFile(file, "utf8")) as OutboxState; } catch { return null; } },
      save: async (s) => { const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(s), "utf8"); await fs.rename(tmp, file); },
    }, meta.grant_id, randomUUID(), () => Date.now(), randomUUID);
    const executors = this.executors(), journalFile = path.join(dir, `classroom-ops-journal-${meta.grant_id}.json`);
    const runner = new CommandRunner({
      executors, monotonic: () => performance.now(), now: () => Date.now(), epoch: () => this.epoch, log: this.log,
      journal: {
        load: async () => { try { return JSON.parse(await fs.readFile(journalFile, "utf8")) as JournalState; } catch { return null; } },
        save: async (s) => { const tmp = `${journalFile}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(s), "utf8"); await fs.rename(tmp, journalFile); },
      },
      // The learner always sees that an instructor acted; their own Stop and files are untouched.
      notify: (line) => void vscode.window.showInformationMessage(line),
    });
    await runner.recover();
    if (!live()) { runner.close(); return; } // disconnected while the journal was being read
    this.runner = runner;
    // U2 inbox. Only a connection that knows whose seat it is can hold one (the directory is per run, seat and learner).
    let inbox: InboxSession | null = null;
    if (meta.student) {
      const pointer: InboxPointer = { cohort: meta.student.c, run: meta.class_run_id, seat: meta.seat_id, student: meta.student.u, hidden: false, ends_at: meta.run?.ends_at ?? meta.expires_at, grant: meta.grant_id };
      const store = new InboxStore(inboxDir(dir, pointer));
      await this.context.globalState.update(INBOX_KEY, pointer);
      // Files a previous run of this app fetched but never committed are removed, never promoted: their deadline died with it.
      await store.reconcile(Date.now()).catch((err) => this.log(`[inbox] reconcile: ${(err as Error).message}`));
      if (!live()) { runner.close(); return; }
      inbox = new InboxSession({ store, alive: live, clock: { mono: () => performance.now(), wall: () => Date.now() }, log: this.log, changed: () => { if (live()) this.inboxChanged(true); } });
      this.inbox = inbox; this.inboxStore = store; this.inboxChanged(false);
    }
    this.loop = startOpsSync({
      ...(inbox ? { distribution: inbox } : {}),
      capabilities: [...OPS_CLIENT_CAPABILITIES, RECOVERY_FOLLOWUP_CAPABILITY, "commands", ...Object.keys(executors), ...(inbox ? [INBOX_CAPABILITY, INBOX_PROMPT_CAPABILITY, LESSON_BINDING_CAPABILITY] : [])], onEpoch: (e) => { if (live()) this.epoch = e; },
      commands: runner as unknown as NonNullable<Parameters<typeof startOpsSync>[0]["commands"]>,
      post: (body, timeoutMs) => this.post(credential, body, timeoutMs), outbox: this.outbox, appInstanceId: this.appInstanceId,
      sample: () => { const r = this.runtime(); const changed = this.runtimeGate.next(r.status); if (changed) void this.outbox?.add("runtime", runtimePayload(changed)); return { idle_ms: Math.max(0, Math.round(r.idleMs)), runtime_status: r.status, control_revision: this.controlRevision }; },
      // The revision is reported only after the hold is actually in place on this device.
      onControl: (control) => { if (!live()) return; this.paused = control.paused; this.applyHold(); this.controlRevision = control.control_revision; },
      now: () => Date.now(), random: Math.random, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      log: this.log,
      // Normal expiry keeps the credential for the upload-only afterlife; a revoked or replaced connection is dropped outright.
      onDisconnected: (reason) => { if (!live()) return; this.log(`[ops] disconnected: ${reason}`); if (reason === "ops_grant_expired") { void this.inboxExpired(); this.stopConnection(); void this.resumeUploadOnly(meta, credential); } else { void this.hideInbox(meta.grant_id); void this.forget(); } },
    }, meta.poll_after_ms);
    this.context.subscriptions.push({ dispose: () => this.loop?.stop() });
    // The usual order in a class is "token first, pair later": the token was verified BEFORE this connection existed, so that
    // result had nowhere to go and the board would show the token as unknown until some later refresh. Ask once, now.
    // …but only as the FIRST word on this connection. The answer can come back after the learner's first turn has already
    // reported "runtime ready" or a fault; an older fact must not overwrite a newer one.
    this.activationGate.reset(); this.errorGate.reset();
    void Promise.resolve().then(() => this.actions.probeProfile()).then((p) => { if (live() && !p.noToken && this.activationGate.untouched && this.errorGate.untouched) this.profileResult(p, this.token); }).catch(() => {});
  }

  // ── U3: a lesson SETTING this device holds is switched at the START of the learner's next turn ──
  /**
   * Asks the Service to record the switch. Never mid-turn logic of its own: the caller is the turn preflight, and a turn that
   * is already running keeps the snapshot the Service admitted it with. Any failure leaves the setting pending — the turn
   * then goes out exactly as it would have, and the switch is tried again at the next turn.
   */
  async switchPendingSetting(baseLessonSha256: string): Promise<{ state: "none" } | { state: "switched"; key: string; seq: number; object_id: string; revision: number; content_hash: string; lesson: LessonRef | "base" } | { state: "failed"; reason: string; final: boolean }> {
    const store = this.inboxStore, credential = this.credential, gen = this.generation, token = this.token;
    if (!store || !credential || !this.meta || !token) return { state: "none" };
    let pending: ReturnType<typeof pendingSetting>;
    try { pending = pendingSetting((await store.current()).index); } catch { return { state: "none" }; }
    if (!pending || !/^[a-f0-9]{64}$/.test(baseLessonSha256)) return { state: "none" };
    try {
      const res = await fetch(`${this.base()}/classroom/ops/lesson-binding`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, signal: AbortSignal.timeout(4000),
        body: JSON.stringify({ app_instance_id: this.appInstanceId, offer_key: pending.offer_key, distribution_id: pending.distribution_id, object_id: pending.object_id, revision: pending.revision, content_hash: pending.content_hash, base_lesson_sha256: baseLessonSha256,
          // The Service verifies THIS token to establish the lesson the switch starts from; the hash above is only cross-checked.
          learner_token: token }) });
      const body = await res.json().catch(() => null) as { recorded?: boolean; reason?: string; final?: boolean; binding?: { key: string; seq: number } } | null;
      // An answer that arrives after this connection ended decides nothing (the same rule as every other operations answer).
      if (gen !== this.generation) return { state: "failed", reason: "connection_closed", final: false };
      if (body?.recorded && body.binding && /^[a-f0-9]{32}$/.test(body.binding.key)) return { state: "switched", key: body.binding.key, seq: body.binding.seq, object_id: pending.object_id, revision: pending.revision, content_hash: pending.content_hash, lesson: pending.lesson };
      return { state: "failed", reason: body?.reason ?? `http_${res.status}`, final: body?.final === true };
    } catch { return { state: "failed", reason: "network", final: false }; }
  }
  /** Called only after the served profile was verified to carry this key: the device's own note that it is bound. */
  async confirmSettingBound(o: { object_id: string; revision: number; content_hash: string; key: string; seq: number }): Promise<void> {
    const store = this.inboxStore; if (!store) return;
    try { await store.commit((index) => { const next = markSettingBound(index, o); return { next: next === index ? null : next, result: null }; }); this.inboxChanged(false); } catch (err) { this.log(`[inbox] binding note not saved: ${(err as Error).message}`); }
  }
  /**
   * Does this learner's shared inbox hold a lesson setting at all (pending or already bound)? Read-only, any window. A profile
   * cached before the Service began to enforce bindings says nothing about them; this is the device's own reason to look again.
   */
  async holdsLessonSetting(): Promise<boolean> {
    const p = this.context.globalState.get<InboxPointer>(INBOX_KEY), me = tokenIdentityUnverified(this.token);
    if (!p || p.hidden || !me.u || me.u !== p.student || me.c !== p.cohort) return false;
    try { const index = (await new InboxStore(inboxDir(this.context.globalStorageUri.fsPath, p)).current()).index; return pendingSetting(index) !== null || boundSetting(index) !== null; } catch { return false; }
  }
  /** What any window of this learner can read from the shared inbox: the binding the owner window last verified. */
  async knownBindingKey(): Promise<string | null> {
    const p = this.context.globalState.get<InboxPointer>(INBOX_KEY), me = tokenIdentityUnverified(this.token);
    if (!p || p.hidden || !me.u || me.u !== p.student || me.c !== p.cohort) return null;
    try { return boundSetting((await new InboxStore(inboxDir(this.context.globalStorageUri.fsPath, p)).current()).index)?.key ?? null; } catch { return null; }
  }

  private async post(credential: string, body: unknown, timeoutMs: number): Promise<SyncResponse> {
    try {
      const res = await fetch(`${this.base()}/classroom/ops/sync`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      const retry = Number(res.headers.get("retry-after"));
      return { status: res.status, body: await res.json().catch(() => undefined) as SyncResponse["body"], retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : undefined };
    } catch {
      return { status: 0 };
    }
  }

  // ── observations from the chat provider ──

  profileResult(r: { ok: boolean; status?: number; code?: string; requestId?: string; network?: boolean }, token: string): void {
    const before = this.token; this.token = token || this.token;
    if (this.token !== before) this.inboxChanged(false); // whose inbox may be shown depends on who is signed in
    const id = tokenIdentityUnverified(token), seat = this.meta?.student;
    // Shared PC: someone else signed in. This seat's connection must not report, run commands or upload for them.
    if (r.ok && seat && id.u && id.c && (id.u !== seat.u || id.c !== seat.c)) {
      this.log("[ops] a different learner signed in on this device — classroom connection dropped");
      void this.forget(); void vscode.window.showInformationMessage("다른 사용자로 로그인되어 이전 수업 연결을 끊었습니다. 이번 수업에 연결하려면 강사에게 새 연결 코드를 받으세요."); return;
    }
    if (!this.outbox) return;
    if (r.ok) {
      if (this.activationGate.next(`verified:${id.jti}`)) void this.outbox.add("activation", activationPayload("token_verified", { tokenJti: id.jti, tokenExp: id.exp }));
      // U4 — a verified token disproves token, class-gate and network faults only. A runtime fault stays until a turn completes.
      if (profileCheckClears(this.faultClass)) { this.faultClass = null; if (this.errorGate.next("clear")) void this.outbox.add("error", errorPayload("unknown", { blocking: false, cleared: true })); }
    } else {
      const cls = classifyFailure({ status: r.status, code: r.code, networkError: r.network });
      this.faultClass = cls;
      // A dead network says nothing about the token: report the error, not a rejection.
      if (cls !== "network" && this.activationGate.next(`rejected:${cls}`)) void this.outbox.add("activation", activationPayload("token_rejected", { reason: cls, httpStatus: r.status }));
      if (this.errorGate.next(`${cls}:${r.status}`)) void this.outbox.add("error", errorPayload(cls, { code: r.status ? `http_${r.status}` : undefined, requestId: r.requestId, blocking: cls !== "network" }));
    }
    this.loop?.nudge();
  }

  turnResult(t: import("./classroomOps").TurnOutcome): void {
    if (!this.outbox) return;
    if (!t.aborted) this.faultClass = t.ok ? (t.sdkFallback ? "sdk_not_ready" : t.toolFailed ? "tool_not_ready" : null) : turnFailureClass(t);
    let added = false;
    // U4 — the learner's own next question answers the last stop / restart. One answer per command, never a request of our own.
    const answer = this.recoveryWatch.onTurn(t, this.epoch); if (answer) { void this.outbox.add("recovery", answer); added = true; }
    for (const o of turnObservations(t)) {
      const gate = o.kind === "activation" ? this.activationGate : this.errorGate;
      // Reported on change, not per turn. "cleared" shares its key with the profile check so the two do not echo each other.
      if (gate.next(o.payload.cleared ? "clear" : JSON.stringify(o.payload))) { void this.outbox.add(o.kind, o.payload, o.actor); added = true; }
    }
    if (added) this.loop?.nudge();
  }
  private currentStep = "";
  lessonStep(lessonVersion: string, stepId: string, status: "in_progress" | "submitted"): void {
    if (!this.outbox || !/^[A-Za-z0-9_.:+-]{1,64}$/.test(lessonVersion) || !/^[A-Za-z0-9_-]{1,128}$/.test(stepId)) return;
    this.currentStep = stepId;
    void this.outbox.add("step", stepPayload(lessonVersion, status, stepId), "student");
    // "I finished this step" is the learner's own statement: self-reported, not a verified completion.
    if (status === "submitted") void this.outbox.add("evidence", evidencePayload("decision", { sourceState: "self_reported", stepId }), "student");
    this.loop?.nudge();
  }
  artifactChanged(before: string | undefined, after: string, stepId?: string): void {
    if (!this.outbox || before === after) return;
    void this.outbox.add("evidence", evidencePayload("change", { sourceState: "real", stepId: stepId ?? (this.currentStep || undefined), before, after }), "ai");
    this.loop?.nudge();
  }

  /** The existing trace endpoint sits behind the active-class and roster gate, so its first 2xx is the entry evidence. */
  traceResult(status: number): void {
    if (!this.outbox || status < 200 || status >= 300) return;
    if (this.activationGate.next("entered")) { void this.outbox.add("activation", activationPayload("class_entered")); this.loop?.nudge(); }
  }
}
