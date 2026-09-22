// Host adapter for remote classroom operations (#751). VS Code, SecretStorage,
// disk and fetch live here; every decision lives in classroomOps.ts.
//
// The operations credential is separate from the learning token on purpose: it
// can only report this seat's status, and the learner can drop it at any time.
import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import {
  ChangeGate, OPS_CLIENT_CAPABILITIES, OPS_PROTOCOL, OpsOutbox, activationPayload, classifyFailure, errorPayload,
  runtimePayload, startOpsSync, tokenIdentityUnverified, type OpsSyncLoop, type OutboxState, type RuntimeStatus, type SyncResponse,
} from "./classroomOps";

const CREDENTIAL_KEY = "hypeproof.classroomOps.credential";
const META_KEY = "hypeproof.classroomOps.connection";
interface ConnectionMeta { grant_id: string; class_run_id: string; seat_id: string; expires_at: number; poll_after_ms: number }

/** What the chat provider is allowed to tell this adapter. No message text, no paths. */
export interface ClassroomOpsObserver {
  profileResult(r: { ok: boolean; status?: number; code?: string; requestId?: string; network?: boolean }, token: string): void;
  traceResult(status: number): void;
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

  constructor(context: vscode.ExtensionContext, runtime: () => { idleMs: number; status: RuntimeStatus }, log: (line: string) => void) {
    this.context = context; this.runtime = runtime; this.log = log;
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
    if (meta.expires_at <= Date.now()) { await this.forget(); return; }
    await this.start(meta, credential);
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
        body: JSON.stringify({ ticket, app_instance_id: this.appInstanceId, boot_id: randomUUID(), protocol: OPS_PROTOCOL, capabilities: OPS_CLIENT_CAPABILITIES, app_version: this.version() }),
      });
    } catch {
      void vscode.window.showWarningMessage("서버에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 같은 코드로 다시 시도하세요."); return;
    }
    if (res.status === 404) { void vscode.window.showInformationMessage("이 수업 서버에는 수업 연결 기능이 켜져 있지 않습니다. 수업 참여에는 영향이 없습니다."); return; }
    if (res.status === 429) { void vscode.window.showWarningMessage("연결 시도가 너무 많습니다. 1분 뒤 다시 시도하세요."); return; }
    if (res.status !== 201) { void vscode.window.showWarningMessage("연결 코드가 맞지 않거나 이미 사용됐거나 시간이 지났습니다. 강사에게 새 코드를 요청하세요."); return; }
    const b = (await res.json()) as ConnectionMeta & { credential: string };
    await this.loop?.stop();
    await this.context.secrets.store(CREDENTIAL_KEY, b.credential);
    const meta: ConnectionMeta = { grant_id: b.grant_id, class_run_id: b.class_run_id, seat_id: b.seat_id, expires_at: b.expires_at, poll_after_ms: b.poll_after_ms };
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

  private async forget(): Promise<void> {
    this.loop?.stop(); this.loop = null; this.outbox = null;
    await this.context.secrets.delete(CREDENTIAL_KEY);
    await this.context.globalState.update(META_KEY, undefined);
  }

  private async start(meta: ConnectionMeta, credential: string): Promise<void> {
    const dir = this.context.globalStorageUri.fsPath; await fs.mkdir(dir, { recursive: true });
    // One file per grant: a shared PC's next learner never inherits the previous seat's queue.
    const file = path.join(dir, `classroom-ops-outbox-${meta.grant_id}.json`);
    this.outbox = await OpsOutbox.open({
      load: async () => { try { return JSON.parse(await fs.readFile(file, "utf8")) as OutboxState; } catch { return null; } },
      save: async (s) => { const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(s), "utf8"); await fs.rename(tmp, file); },
    }, meta.grant_id, randomUUID(), () => Date.now(), randomUUID);
    this.loop = startOpsSync({
      post: (body, timeoutMs) => this.post(credential, body, timeoutMs), outbox: this.outbox, appInstanceId: this.appInstanceId,
      sample: () => { const r = this.runtime(); const changed = this.runtimeGate.next(r.status); if (changed) void this.outbox?.add("runtime", runtimePayload(changed)); return { idle_ms: Math.max(0, Math.round(r.idleMs)), runtime_status: r.status }; },
      now: () => Date.now(), random: Math.random, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      log: this.log,
      onDisconnected: (reason) => { this.log(`[ops] disconnected: ${reason}`); void this.forget(); },
    }, meta.poll_after_ms);
    this.context.subscriptions.push({ dispose: () => this.loop?.stop() });
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
    if (!this.outbox) return;
    const id = tokenIdentityUnverified(token);
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

  /** The existing trace endpoint sits behind the active-class and roster gate, so its first 2xx is the entry evidence. */
  traceResult(status: number): void {
    if (!this.outbox || status < 200 || status >= 300) return;
    if (this.activationGate.next("entered")) { void this.outbox.add("activation", activationPayload("class_entered")); this.loop?.nudge(); }
  }
}
