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
import { freezeSnapshot, uploadSnapshot, type SnapshotBinding, type SnapshotDeps, type SnapshotScope, type SnapshotState } from "./evidenceSnapshot";
import { removeFrozenCopy } from "./evidenceSnapshotStore";
import { resetPostcondition, runPreservingReset, stopAndConfirm, type Preservation, type ResetManifest, type ResetSteps } from "./runtimeReset";
import {
  ChangeGate, OPS_CLIENT_CAPABILITIES, OPS_PROTOCOL, OpsOutbox, activationPayload, classifyFailure, errorPayload,
  evidencePayload, runtimePayload, stepPayload, turnObservations, uploadPayload, startOpsSync, tokenIdentityUnverified, type OpsSyncLoop, type OutboxState, type RuntimeStatus, type SyncResponse,
} from "./classroomOps";

const CREDENTIAL_KEY = "hypeproof.classroomOps.credential";
const META_KEY = "hypeproof.classroomOps.connection";
/** `student`/`run`/`lesson` come from the Service's connect response: they are what a collected snapshot is bound to. */
interface ConnectionMeta { grant_id: string; class_run_id: string; seat_id: string; expires_at: number; poll_after_ms: number; student?: { u: string; c: string; p: string }; run?: { starts_at: number; ends_at: number }; lesson?: { course_id: string; version: string } | null }
/** After its normal expiry a connection can only finish an upload that was already authorized, for this long after class. */
const UPLOAD_GRACE_MS = 24 * 3_600_000;
const FINAL_CREDENTIAL_REFUSALS = ["ops_credential_invalid", "ops_grant_revoked", "ops_grant_expired"];

/** The only things a remote command may touch. No shell, no file access, no history, no arbitrary VS Code command. */
export interface ClassroomOpsActions {
  hasActiveRun(): boolean;
  /** Re-verify the stored learning token against the Service without changing panel state. */
  probeProfile(): Promise<{ ok: boolean; status?: number; code?: string; requestId?: string; network?: boolean; noToken?: boolean }>;
  refreshProfile(): Promise<boolean>;
  recoverPreview(): Promise<{ state: "no_preview" | "reloaded" | "restarted"; healthy: boolean }>;
  // R3 — stop / preserving reset / pause. Nothing here can clear history or delete a file.
  requestStop(): void;
  freezeInput(frozen: boolean): Promise<void>;
  preservation(): Promise<Preservation>;
  runtimeGeneration(): number;
  newGeneration(): Promise<number>;
  setHold(hold: "paused" | "stop_unconfirmed" | null): void;
  // R4 — allowlisted spool files of the current session, read-only.
  readSpool(): Promise<Array<{ name: string; data: Uint8Array }> | null>;
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

  constructor(context: vscode.ExtensionContext, runtime: () => { idleMs: number; status: RuntimeStatus }, actions: ClassroomOpsActions, log: (line: string) => void) {
    this.context = context; this.runtime = runtime; this.actions = actions; this.log = log;
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
  private runner: CommandRunner | null = null;
  private scope(): SnapshotScope | null {
    const m = this.meta; if (!m?.student || !m.run) return null; // a connection made before the binding contract cannot collect
    return { grant_id: m.grant_id, class_run_id: m.class_run_id, seat_id: m.seat_id, student: m.student, activity: m.lesson ? { course_id: m.lesson.course_id, version: m.lesson.version } : null, run: m.run };
  }
  private snapshotDeps(consent: { purpose: string; notice_version: string } | null = null): SnapshotDeps {
    const dir = path.join(this.context.globalStorageUri.fsPath, "classroom-snapshots"), safe = (s: string) => s.replace(/[^A-Za-z0-9-]/g, "");
    const stateFile = (b: string) => path.join(dir, `${safe(b)}.state.json`), copyDir = (b: string, r: number) => path.join(dir, safe(b), `r${r}`);
    const call = async (url: string, init: RequestInit) => { try { const res = await fetch(`${this.base()}/classroom/ops/collect/${url}`, { ...init, signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${this.credential}`, ...(init.headers ?? {}) } }); const j = (await res.json().catch(() => ({}))) as Record<string, string>; return { status: res.status, reason: j.reason, receipt_id: j.receipt_id, coverage: j.coverage }; } catch { return { status: 0 }; } };
    return {
      scope: () => this.scope(),
      // The immutable copy: written once per (batch, revision) and only ever read back afterwards — with the binding it was frozen under.
      copy: async (b, r) => {
        const target = copyDir(b, r), bindingFile = path.join(target, "binding.json");
        try {
          const binding = JSON.parse(await fs.readFile(bindingFile, "utf8")) as SnapshotBinding;
          const files = await Promise.all(["session.meta.json", "events.jsonl"].map(async (name) => ({ name, data: new Uint8Array(await fs.readFile(path.join(target, name))) })));
          return { files, binding };
        } catch { /* not copied yet */ }
        // Resuming never reads the live spool: without the frozen copy and an explicit consent scope there is nothing to send.
        const scope = this.scope(); if (!scope || !consent) return null;
        const live = await this.actions.readSpool(); if (!live) return null;
        const frozen = freezeSnapshot(live, scope, b, consent, Date.now()); if (!frozen.ok) return { code: frozen.code };
        await fs.mkdir(target, { recursive: true });
        for (const f of frozen.files) await fs.writeFile(path.join(target, f.name), f.data, { flag: "wx" });
        await fs.writeFile(bindingFile, JSON.stringify(frozen.binding), { flag: "wx" });
        return { files: frozen.files, binding: frozen.binding };
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
      refresh_connection: { mutating: false, run: async () => {
        // Never under a running turn: a refresh must not disturb work in progress.
        if (this.actions.hasActiveRun()) return { ok: false, code: "busy_active_run" };
        return (await this.actions.refreshProfile()) ? { ok: true, code: "profile_verified" } : { ok: false, code: "profile_not_verified" };
      } },
      cancel_current_run: { mutating: true, label: "지금 실행 중인 작업 멈추기", run: async () => {
        const stopped = await stopAndConfirm({ requestStop: () => this.actions.requestStop(), isStopped: () => !this.actions.hasActiveRun(), wait: (ms) => new Promise((r) => setTimeout(r, ms)) });
        // An unconfirmed stop holds NEW runs only. What already happened outside is not undone, and is not claimed to be.
        this.stopUnconfirmed = !stopped; this.applyHold();
        return stopped ? { ok: true, code: "run_stopped" } : { ok: false, code: "stop_unconfirmed" };
      } },
      reset_runtime: { mutating: true, label: "AI 세션 다시 시작 (대화와 파일은 그대로)",
        run: async (signal, command) => {
          const r = await runPreservingReset(command.command_id, this.resetSteps(command.command_id), signal);
          if (r.code === "stop_unconfirmed") { this.stopUnconfirmed = true; this.applyHold(); }
          if (r.ok) { this.stopUnconfirmed = false; this.applyHold(); }
          return r;
        },
        postcondition: async (command) => resetPostcondition(await this.readManifest(command.command_id), this.actions.runtimeGeneration()),
      },
      // R4 — issued by the Service as part of a collection batch the learner consented to. Reads the spool; changes nothing.
      retry_evidence_upload: { mutating: false, acceptsArgs: (a) => typeof a.batch_id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(a.batch_id) && Object.keys(a).every((k) => ["batch_id", "purpose", "notice_version"].includes(k)),
        run: async (_s, command) => { const r = await uploadSnapshot(String(command.args.batch_id), this.snapshotDeps({ purpose: String(command.args.purpose ?? ""), notice_version: String(command.args.notice_version ?? "") })); void this.outbox?.add("upload", uploadPayload(r.ok ? "verified" : r.code === "offline_pending" ? "pending" : "failed")); return r; } },
      // Coaching: a question or a pointer, shown without covering the work. Nothing on disk or in the conversation changes.
      send_question: { mutating: false, acceptsArgs: (a) => Object.keys(a).join() === "text" && typeof a.text === "string" && a.text.length <= 300,
        run: async (_s, command) => { this.showCoaching("강사의 질문", String(command.args.text)); return { ok: true, code: "shown" }; } },
      mark_checkpoint: { mutating: false, acceptsArgs: (a) => Object.keys(a).every((k) => k === "step_id" || k === "note") && Object.values(a).every((v) => typeof v === "string" && v.length <= 200),
        run: async (_s, command) => { this.showCoaching("강사가 다시 보라고 표시한 지점", [command.args.step_id ? `단계 ${command.args.step_id}` : "", command.args.note ?? ""].filter(Boolean).join(" · ") || "현재 작업"); return { ok: true, code: "shown" }; } },
      restart_preview: { mutating: false, run: async () => {
        const r = await this.actions.recoverPreview();
        if (r.state === "no_preview") return { ok: false, code: "no_preview" };
        // A restarted server has a new port: say so rather than claim the open tab recovered.
        return r.healthy ? { ok: true, code: r.state === "reloaded" ? "preview_reloaded" : "preview_restarted_new_url" } : { ok: false, code: "preview_unhealthy" };
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
        body: JSON.stringify({ ticket, app_instance_id: this.appInstanceId, boot_id: randomUUID(), protocol: OPS_PROTOCOL, capabilities: [...OPS_CLIENT_CAPABILITIES, "commands", ...Object.keys(this.executors())], app_version: this.version() }),
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
    const meta: ConnectionMeta = { grant_id: b.grant_id, class_run_id: b.class_run_id, seat_id: b.seat_id, expires_at: b.expires_at, poll_after_ms: b.poll_after_ms, ...(b.student ? { student: b.student } : {}), ...(b.run ? { run: b.run } : {}), lesson: b.lesson ? { course_id: b.lesson.course_id, version: b.lesson.version } : null };
    await this.context.globalState.update(META_KEY, meta);
    await this.start(meta, b.credential);
    void vscode.window.showInformationMessage(
      `수업에 연결했습니다 (좌석 ${b.seat_id}). 강사 화면에는 입장·단계·오류 상태만 보입니다. 대화 내용과 파일은 보내지 않으며, 이 연결로는 AI를 쓸 수 없습니다. 명령 팔레트의 ‘수업 연결 끊기’로 언제든 끊을 수 있습니다.`,
    );
  }

  async disconnectInteractively(): Promise<void> {
    await this.forget();
    void vscode.window.showInformationMessage("수업 연결을 끊었습니다. 수업 참여와 작업 파일은 그대로입니다.");
  }

  /** End the current connection in this window: no late response, queued approval or pause may act after this line. */
  private stopConnection(): void {
    this.generation++;
    this.loop?.stop(); this.runner?.close(); this.loop = null; this.runner = null; this.outbox = null;
    // Disconnecting ends the instructor's pause on this device; the Service's own admission still applies.
    this.paused = false; this.stopUnconfirmed = false; this.applyHold();
  }
  private async forget(): Promise<void> {
    this.stopConnection(); this.credential = ""; this.meta = null;
    await this.context.secrets.delete(CREDENTIAL_KEY);
    await this.context.globalState.update(META_KEY, undefined);
  }

  private async start(meta: ConnectionMeta, credential: string): Promise<void> {
    this.stopConnection();
    const gen = this.generation, live = () => gen === this.generation;
    this.credential = credential; this.meta = meta; void this.resumePendingUploads();
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
    this.loop = startOpsSync({
      capabilities: [...OPS_CLIENT_CAPABILITIES, "commands", ...Object.keys(executors)], onEpoch: (e) => { if (live()) this.epoch = e; },
      commands: runner as unknown as NonNullable<Parameters<typeof startOpsSync>[0]["commands"]>,
      post: (body, timeoutMs) => this.post(credential, body, timeoutMs), outbox: this.outbox, appInstanceId: this.appInstanceId,
      sample: () => { const r = this.runtime(); const changed = this.runtimeGate.next(r.status); if (changed) void this.outbox?.add("runtime", runtimePayload(changed)); return { idle_ms: Math.max(0, Math.round(r.idleMs)), runtime_status: r.status, control_revision: this.controlRevision }; },
      // The revision is reported only after the hold is actually in place on this device.
      onControl: (control) => { if (!live()) return; this.paused = control.paused; this.applyHold(); this.controlRevision = control.control_revision; },
      now: () => Date.now(), random: Math.random, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      log: this.log,
      // Normal expiry keeps the credential for the upload-only afterlife; a revoked or replaced connection is dropped outright.
      onDisconnected: (reason) => { if (!live()) return; this.log(`[ops] disconnected: ${reason}`); if (reason === "ops_grant_expired") { this.stopConnection(); void this.resumeUploadOnly(meta, credential); } else void this.forget(); },
    }, meta.poll_after_ms);
    this.context.subscriptions.push({ dispose: () => this.loop?.stop() });
    // The usual order in a class is "token first, pair later": the token was verified BEFORE this connection existed, so that
    // result had nowhere to go and the board would show the token as unknown until some later refresh. Ask once, now.
    // …but only as the FIRST word on this connection. The answer can come back after the learner's first turn has already
    // reported "runtime ready" or a fault; an older fact must not overwrite a newer one.
    this.activationGate.reset(); this.errorGate.reset();
    void Promise.resolve().then(() => this.actions.probeProfile()).then((p) => { if (live() && !p.noToken && this.activationGate.untouched && this.errorGate.untouched) this.profileResult(p, this.token); }).catch(() => {});
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
    this.token = token || this.token;
    const id = tokenIdentityUnverified(token), seat = this.meta?.student;
    // Shared PC: someone else signed in. This seat's connection must not report, run commands or upload for them.
    if (r.ok && seat && id.u && id.c && (id.u !== seat.u || id.c !== seat.c)) {
      this.log("[ops] a different learner signed in on this device — classroom connection dropped");
      void this.forget(); void vscode.window.showInformationMessage("다른 사용자로 로그인되어 이전 수업 연결을 끊었습니다. 이번 수업에 연결하려면 강사에게 새 연결 코드를 받으세요."); return;
    }
    if (!this.outbox) return;
    if (r.ok) {
      if (this.activationGate.next(`verified:${id.jti}`)) void this.outbox.add("activation", activationPayload("token_verified", { tokenJti: id.jti, tokenExp: id.exp }));
      if (this.errorGate.next("clear")) void this.outbox.add("error", errorPayload("unknown", { blocking: false, cleared: true }));
    } else {
      const cls = classifyFailure({ status: r.status, code: r.code, networkError: r.network });
      // A dead network says nothing about the token: report the error, not a rejection.
      if (cls !== "network" && this.activationGate.next(`rejected:${cls}`)) void this.outbox.add("activation", activationPayload("token_rejected", { reason: cls, httpStatus: r.status }));
      if (this.errorGate.next(`${cls}:${r.status}`)) void this.outbox.add("error", errorPayload(cls, { code: r.status ? `http_${r.status}` : undefined, requestId: r.requestId, blocking: cls !== "network" }));
    }
    this.loop?.nudge();
  }

  turnResult(t: import("./classroomOps").TurnOutcome): void {
    if (!this.outbox) return;
    let added = false;
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
