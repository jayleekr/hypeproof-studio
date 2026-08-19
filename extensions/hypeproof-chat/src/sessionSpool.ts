// #580 — 세션 로그 로컬 스풀 (수집 계층).
//
// Studio 를 지나가는 것들 — 질문 원문 · 요청 단위 토큰 usage · 행동 워크플로우 —
// 을 각 PC 의 세션 디렉토리에 append-only JSONL 로 남긴다. 업로드 계층(후속 PR)
// 이 이 디렉토리를 통째로 올린다. 결정과 근거: 이슈 #580 설계 확정 노트.
//
//   <root>/<yyyy-mm-dd>/<session-uuid>/
//     session.meta.json   누구(u·c·p) · 앱 버전 · OS · 시작 시각
//     events.jsonl        단일 append 스트림 — type 판별자 union, 레코드마다
//                         schema_version. 순서가 곧 데이터다(시퀀스 분석).
//
// 규율:
// - vscode 를 import 하지 않는다 — test/session-spool.smoke.mjs 가 플레인
//   Node 로 검증한다 (chatPanelHelpers.ts 와 같은 관례).
// - 스풀은 제품을 절대 죽이지 않는다. 모든 쓰기 실패는 삼키고 사유당 1회만
//   경고한다. record* 는 동기 시그니처이고 내부 큐가 순서를 보존한다.
// - 비용은 부풀리는 쪽이 더 나쁜 실패다. SDK 경로의 dedupe 키 없는 usage 는
//   기록을 포기한다(#503: SDK 는 API 응답 1개를 여러 메시지로 쪼개며 같은
//   usage 를 복제한다). 전량 원장은 어차피 서버 D1 usage_log 에 있다.
// - 상태 전이는 전부 **큐 안에서** 일어난다. 첫 구현은 noteIdentity 가 큐
//   밖에서 세션을 동기 교체했고, 큐에 남아 있던 앞 학생의 이벤트가 뒷 학생의
//   세션에 적히는 인터리빙이 리뷰에서 실증됐다(같은 PC 학생 교체 — REQ-Q2 의
//   바로 그 시나리오). 턴 단위 이벤트는 프롬프트 시점의 세션에 피닝된다.

import * as fs from "fs";
import * as path from "path";
import { decodeTokenPayloadUnverified } from "./chatPanelHelpers.ts";
import { UPLOADED_MARKER } from "./spoolUploader.ts";

export const SPOOL_SCHEMA_VERSION = 1;

/**
 * 업로드 여부와 무관한 스풀 총량 캡. "업로드 성공 후 N일 정리"만으로는 아무도
 * 업로드를 누르지 않는 강의장 PC 에서 디스크가 무한 증식한다 (#580 D7).
 */
export const SPOOL_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/** prompt 레코드의 text 상한 — 붙여넣기 폭주가 스풀을 잠식하지 않게. */
export const SPOOL_MAX_TEXT_CHARS = 20_000;

/** workflow payload 의 문자열 값 상한 (웹뷰발 자유 텍스트 방어). */
const WORKFLOW_TEXT_CHARS = 500;

/** requestKey dedupe 창. 세션 하나가 이걸 넘는 요청을 만들 일은 없다. */
const SEEN_REQUEST_KEYS_MAX = 2_000;

/** 턴 → 세션 피닝 상한. 초과 시 오래된 피닝부터 잊는다(현재 세션으로 폴백). */
const PINNED_TURNS_MAX = 100;

/**
 * #596 — 업로드 성공(마커 존재) 세션의 로컬 보존 기간. R2 에 완결본이 있고
 * 며칠의 대조 여유만 남기면 되므로 짧다 (#580 AC 6 "성공 후 N일 정리").
 */
const UPLOADED_RETAIN_MS = 3 * 24 * 60 * 60 * 1000;

export interface SpoolIdentity {
  /** 토큰 payload `u` — 코호트-로컬 핸들 (예: kid01). */
  u: string;
  /** 토큰 payload `c` — 코호트 id. `u` 는 코호트 안에서만 유일하다. */
  c: string;
  /** 토큰 payload `p` — 프로필 id. */
  p?: string;
}

/**
 * 토큰에서 스풀 신원을 뽑는다. 서명 검증 없는 디코드 — 접근 제어가 아니라
 * 로그 귀속용이다 (extractCohortIdUnverified 와 같은 규율). 토큰 원문·서명·
 * jti 는 어디에도 기록하지 않는다.
 */
export function spoolIdentityFromToken(token: string | null | undefined): SpoolIdentity | null {
  const payload = decodeTokenPayloadUnverified(token);
  const u = payload?.u;
  const c = payload?.c;
  if (typeof u !== "string" || !u.trim() || typeof c !== "string" || !c.trim()) return null;
  const p = payload?.p;
  return { u, c, ...(typeof p === "string" && p.trim() ? { p } : {}) };
}

/**
 * 스풀 루트. seededSdkBinaryPath 와 같은 이유로 globalStorageUri 가 아니라
 * 고정 경로다: 수거 스크립트·업로더·사람이 앱 없이 같은 위치를 알 수 있고,
 * dev 호스트(데이터 폴더 "Code")에서도 경로가 갈라지지 않는다.
 *   darwin — ~/Library/Application Support/HypeProof-Studio/logs/sessions
 *   win32  — %APPDATA%\HypeProof-Studio\logs\sessions
 *   linux  — ${XDG_CONFIG_HOME:-~/.config}/HypeProof-Studio/logs/sessions
 */
export function resolveSpoolSessionsRoot(args: {
  platform: string;
  homeDir: string;
  env?: Record<string, string | undefined>;
}): string {
  const env = args.env ?? {};
  if (args.platform === "win32") {
    const base = env.APPDATA && env.APPDATA.length > 0
      ? env.APPDATA
      : path.win32.join(args.homeDir, "AppData", "Roaming");
    return path.win32.join(base, "HypeProof-Studio", "logs", "sessions");
  }
  if (args.platform === "darwin") {
    return path.posix.join(
      args.homeDir, "Library", "Application Support", "HypeProof-Studio", "logs", "sessions",
    );
  }
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : path.posix.join(args.homeDir, ".config");
  return path.posix.join(base, "HypeProof-Studio", "logs", "sessions");
}

// ── #552 trace 메시지 → workflow 레코드 매핑 ────────────────────────────────
// vscode-free 로 여기 두는 이유: 필드명이 worker/src/routes/trace.ts 의
// TraceEvent union 과 정합해야 하고(spool-then-forward — 후속 워커 전송이 이
// 레코드를 그대로 보낸다), 그 정합은 스모크 테스트가 고정한다. 프로바이더
// 안에 인라인이면 U 계층이 이 계약을 잴 수 없다.

export type TraceWebviewMessage =
  | { type: "traceTrialStart"; taskLabel?: string }
  | { type: "traceTrialEnd"; trialId: string }
  | {
      type: "traceValidationRun";
      trialId: string;
      turnId?: string;
      outcome: string;
      errorsFound?: number;
      errorsFixed?: number;
    }
  | {
      type: "traceHumanAction";
      trialId: string;
      turnId?: string;
      kind: string;
      diffChars?: number;
    };

export function traceMsgToWorkflowRecord(
  msg: TraceWebviewMessage,
): { turnId?: string; event: string; payload?: Record<string, unknown> } {
  switch (msg.type) {
    case "traceTrialStart":
      return {
        event: "trialStart",
        ...(msg.taskLabel ? { payload: { task_label: msg.taskLabel } } : {}),
      };
    case "traceTrialEnd":
      return { event: "trialEnd", payload: { trial_id: msg.trialId } };
    case "traceValidationRun":
      return {
        ...(msg.turnId ? { turnId: msg.turnId } : {}),
        event: "validationRun",
        payload: {
          trial_id: msg.trialId,
          outcome: msg.outcome,
          ...(msg.errorsFound !== undefined ? { errors_found: msg.errorsFound } : {}),
          ...(msg.errorsFixed !== undefined ? { errors_fixed: msg.errorsFixed } : {}),
        },
      };
    case "traceHumanAction":
      return {
        ...(msg.turnId ? { turnId: msg.turnId } : {}),
        event: "humanAction",
        payload: {
          trial_id: msg.trialId,
          kind: msg.kind,
          ...(msg.diffChars !== undefined ? { diff_chars: msg.diffChars } : {}),
        },
      };
  }
}

/** 요청 1건의 토큰 4종 — provider usage 를 가공 없이 캐논화한 값 (#580 D4). */
export interface SpoolUsageRecord {
  turnId: string;
  source: "sdk" | "proxy";
  /**
   * dedupe 키. SDK 는 message.id(API 응답 id — 분할 메시지끼리 공유), proxy 는
   * 워커 request id. null 이면 기록하지 않는다 — SDK 의 메시지 분할 복제
   * 때문에 키 없는 기록은 과대계상이다. proxy 경로는 호출당 정확히 1회
   * 발화가 구조적이라 호출자가 로컬 키(`local-…`)로 폴백해도 안전하다.
   */
  requestKey: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface SpoolEnv {
  /** 세션들이 쌓이는 루트 (resolveSpoolSessionsRoot 결과, 테스트는 tmp). */
  root: string;
  appVersion: string;
  os: { platform: string; release: string; arch: string };
  /**
   * F5 개발 호스트 표식 — meta 에 `dev: true` 로 남아 업로더/분석이 개발 런을
   * 걸러낼 수 있다. (e2e 런은 아예 스풀을 만들지 않는다 — extension.ts 참고.)
   */
  devHost?: boolean;
  /** 테스트 시계 주입. 기본 실제 시각. */
  now?: () => Date;
  maxTotalBytes?: number;
  /** 테스트용 세션 id 주입. 기본 crypto.randomUUID. */
  newSessionId?: () => string;
}

interface SessionState {
  id: string;
  dir: string;
  identity: SpoolIdentity | null;
  startedAt: string;
  /** meta 가 디스크에 성공적으로 쓰였는가 — 실패 시 다음 쓰기에서 재시도. */
  metaWritten: boolean;
  seenRequestKeys: Set<string>;
}

export class SessionSpool {
  private readonly env: SpoolEnv;
  /** append 순서 보존 큐. 실패는 삼킨다 — 스풀이 제품을 죽이면 안 된다. */
  private queue: Promise<void> = Promise.resolve();
  private session: SessionState | null = null;
  /** 아직 세션이 실체화되기 전 도착한 신원. 첫 이벤트에서 meta 에 들어간다. */
  private pendingIdentity: SpoolIdentity | null = null;
  /**
   * 턴 → 세션 피닝. 턴 단위 이벤트(usage·turn_end·turnId 있는 workflow)는
   * 그 턴의 prompt 가 적힌 세션으로 간다 — 스트림 도중 신원이 회전해도
   * 앞 학생의 턴이 뒷 학생의 세션에 적히지 않는다.
   */
  private readonly turnSessions = new Map<string, SessionState>();
  /** 사유(what)당 1회 경고 — 단일 퓨즈면 스윕 경고 하나가 이후 유실을 전부 가린다. */
  private readonly warnedReasons = new Set<string>();

  constructor(env: SpoolEnv) {
    this.env = env;
  }

  /** 테스트·업로더용 — 현재 세션 디렉토리 (아직 없으면 null). */
  currentSessionDir(): string | null {
    return this.session?.dir ?? null;
  }

  /**
   * 토큰에서 온 신원을 반영한다. 세션은 신원 하나에 묶인다(#580 D3): 이미
   * 이벤트가 쌓인 세션에서 다른 학생/코호트로 바뀌면 새 세션으로 회전한다.
   * null(토큰 없음/디코드 실패)은 무시. 전이는 큐 안에서 일어난다 — 앞서
   * 큐에 들어간 이벤트가 전부 이전 세션에 적힌 뒤에 회전된다.
   */
  noteIdentity(identity: SpoolIdentity | null): void {
    if (!identity) return;
    this.enqueue(async () => {
      const current = this.session ? this.session.identity : this.pendingIdentity;
      if (current && sameIdentity(current, identity)) return;
      if (!this.session) {
        this.pendingIdentity = identity;
        return;
      }
      if (this.session.identity === null) {
        // 신원 후착 — 세션 유지, meta 재작성. 실패하면(win32 rename 일시 실패
        // 등) 신원은 커밋하되 metaWritten 을 내려서 **다음 이벤트 쓰기가**
        // meta 를 재시도하게 한다 — 다음 noteIdentity 호출에만 기대면, 토큰
        // 후착 뒤 더 이상 말이 없는 세션이 영영 user:null 로 남는다.
        try {
          await this.writeMeta(this.session, identity);
          this.session.identity = identity;
        } catch (err) {
          this.session.identity = identity;
          this.session.metaWritten = false;
          this.warnOnce("meta", err);
        }
        return;
      }
      // 신원 교체 — 세션 회전. 이전 세션 파일은 그대로 남고, 피닝된 턴은
      // 계속 이전 세션으로 간다.
      this.session = null;
      this.pendingIdentity = identity;
    });
  }

  recordPrompt(e: { turnId: string; runtime: string; text: string; imagesCount?: number }): void {
    this.enqueue(async () => {
      const s = await this.materialize();
      this.pinTurn(e.turnId, s);
      const text = typeof e.text === "string" ? e.text : "";
      const clamped = text.length > SPOOL_MAX_TEXT_CHARS;
      await this.writeEvent(s, {
        type: "prompt",
        turn_id: e.turnId,
        runtime: e.runtime,
        text: clamped ? text.slice(0, SPOOL_MAX_TEXT_CHARS) : text,
        // 무성 절단 금지 — 잘렸으면 잘렸다고, 원래 몇 자였는지 남긴다.
        ...(clamped ? { text_truncated: true, text_original_chars: text.length } : {}),
        ...(e.imagesCount ? { images_count: e.imagesCount } : {}),
      });
    });
  }

  recordUsage(e: SpoolUsageRecord): void {
    const key = e.requestKey;
    if (!key) return; // 키 없는 usage 는 과대계상 위험 — 포기한다.
    this.enqueue(async () => {
      const s = this.sessionForTurn(e.turnId) ?? (await this.materialize());
      if (s.seenRequestKeys.has(key)) return;
      s.seenRequestKeys.add(key);
      if (s.seenRequestKeys.size > SEEN_REQUEST_KEYS_MAX) {
        const oldest = s.seenRequestKeys.values().next().value;
        if (oldest !== undefined) s.seenRequestKeys.delete(oldest);
      }
      await this.writeEvent(s, {
        type: "usage",
        turn_id: e.turnId,
        source: e.source,
        request_key: key,
        model: e.model,
        input_tokens: numeric(e.inputTokens),
        output_tokens: numeric(e.outputTokens),
        cache_read_input_tokens: numeric(e.cacheReadInputTokens),
        cache_creation_input_tokens: numeric(e.cacheCreationInputTokens),
      });
    });
  }

  recordTurnEnd(e: {
    turnId: string;
    status: "ok" | "aborted" | "error";
    runtime: string | null;
    /**
     * 실패의 분류값 (에러 원문 산문이 아니라 `auth:missing`·`transport`·
     * `stall` 같은 enum 성 문자열). status:"error" 만으로는 "usage 없는 턴"
     * 의 원인 분석이 안 된다 — 첫 실기기 검증에서 바로 걸린 공백.
     */
    errorKind?: string;
    /** SDK result 메시지의 턴 합계 — 요청 단위 usage 레코드 합의 대조군. */
    totalUsage?: Record<string, unknown>;
    totalCostUsd?: number;
  }): void {
    this.enqueue(async () => {
      const s = this.sessionForTurn(e.turnId) ?? (await this.materialize());
      this.turnSessions.delete(e.turnId);
      await this.writeEvent(s, {
        type: "turn_end",
        turn_id: e.turnId,
        status: e.status,
        runtime: e.runtime,
        ...(e.errorKind ? { error_kind: e.errorKind.slice(0, 100) } : {}),
        ...(e.totalUsage ? { total_usage: e.totalUsage } : {}),
        ...(typeof e.totalCostUsd === "number" ? { total_cost_usd: e.totalCostUsd } : {}),
      });
    });
  }

  recordWorkflow(e: { turnId?: string; event: string; payload?: Record<string, unknown> }): void {
    this.enqueue(async () => {
      const s = (e.turnId ? this.sessionForTurn(e.turnId) : null) ?? (await this.materialize());
      await this.writeEvent(s, {
        type: "workflow",
        ...(e.turnId ? { turn_id: e.turnId } : {}),
        event: e.event,
        ...(e.payload ? { payload: clampPayload(e.payload) } : {}),
      });
    });
  }

  /** 큐를 비운다 — 테스트와 dispose 용. 결코 reject 하지 않는다. */
  flush(): Promise<void> {
    return this.queue;
  }

  /**
   * 총량 캡 집행 (#580 D7). 큐를 통해 돌므로 materialize 와 경합하지 않는다.
   * 보호 대상: 이 인스턴스의 현재 세션 + **오늘 날짜 디렉토리 전체** — 멀티
   * 윈도우에서 다른 창의 활성 세션을 알 방법이 없으므로 당일은 건드리지
   * 않는다(하루 만에 텍스트 로그로 캡을 넘길 일은 없다). 실패는 삼킨다.
   */
  sweepRetention(): Promise<void> {
    this.enqueue(() => this.sweepNow());
    return this.queue;
  }

  // ── 내부 ──────────────────────────────────────────────────────────────────

  private async sweepNow(): Promise<void> {
    const cap = this.env.maxTotalBytes ?? SPOOL_MAX_TOTAL_BYTES;
    try {
      const today = localDateStamp(this.now());
      const sessions = await listSessionDirs(this.env.root);
      // #596 — 업로드 성공 세션의 보존 정리 (#580 AC 6): 마커가 있고 보존
      // 기간이 지난 세션은 캡과 무관하게 지운다. R2 에 완결본이 있으므로
      // 로컬은 대조 여유분일 뿐이다. 현재 세션은 건드리지 않는다.
      const nowMs = this.now().getTime();
      const removed = new Set<string>();
      for (const { dir } of sessions) {
        if (this.session && dir === this.session.dir) continue;
        const marker = await fs.promises
          .stat(path.join(dir, UPLOADED_MARKER))
          .catch(() => null);
        if (marker && nowMs - marker.mtimeMs > UPLOADED_RETAIN_MS) {
          await fs.promises.rm(dir, { recursive: true, force: true });
          removed.add(dir);
        }
      }
      let total = 0;
      const sized: Array<{ dir: string; day: string; bytes: number; mtimeMs: number }> = [];
      for (const { dir, day } of sessions) {
        if (removed.has(dir)) continue;
        // 세션 디렉토리는 평평하다(파일만) — 하위 디렉토리가 생기면(후속
        // manifest 등) dirSize 를 재귀로 바꿔야 한다.
        const info = await dirSize(dir);
        total += info.bytes;
        sized.push({ dir, day, ...info });
      }
      if (total <= cap) return;
      sized.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const s of sized) {
        if (total <= cap) break;
        if (this.session && s.dir === this.session.dir) continue;
        if (s.day === today) continue;
        await fs.promises.rm(s.dir, { recursive: true, force: true });
        total -= s.bytes;
      }
      for (const day of await fs.promises.readdir(this.env.root).catch(() => [] as string[])) {
        const dayDir = path.join(this.env.root, day);
        const rest = await fs.promises.readdir(dayDir).catch(() => null);
        if (rest !== null && rest.length === 0) {
          await fs.promises.rmdir(dayDir).catch(() => undefined);
        }
      }
    } catch (err) {
      this.warnOnce("retention-sweep", err);
    }
  }

  private enqueue(op: () => Promise<void>): void {
    this.queue = this.queue
      .then(op)
      .catch((err) => this.warnOnce("write", err));
  }

  private now(): Date {
    return (this.env.now ?? (() => new Date()))();
  }

  private pinTurn(turnId: string, s: SessionState): void {
    this.turnSessions.set(turnId, s);
    if (this.turnSessions.size > PINNED_TURNS_MAX) {
      const oldest = this.turnSessions.keys().next().value;
      if (oldest !== undefined) this.turnSessions.delete(oldest);
    }
  }

  private sessionForTurn(turnId: string): SessionState | null {
    return this.turnSessions.get(turnId) ?? null;
  }

  /** 세션 디렉토리를 게으르게 만든다 — 이벤트 없는 창 열기가 빈 디렉토리를 남기지 않게. */
  private async materialize(): Promise<SessionState> {
    if (this.session) return this.session;
    const now = this.now();
    const id = (this.env.newSessionId ?? (() => cryptoRandomUUID()))();
    const s: SessionState = {
      id,
      dir: path.join(this.env.root, localDateStamp(now), id),
      identity: this.pendingIdentity,
      startedAt: now.toISOString(),
      metaWritten: false,
      seenRequestKeys: new Set(),
    };
    await fs.promises.mkdir(s.dir, { recursive: true });
    // meta 실패는 세션을 버릴 이유가 아니다 — 이벤트가 본체고, meta 는 다음
    // 쓰기(writeEvent 의 재시도 가드)에서 다시 시도된다.
    await this.writeMeta(s, s.identity).catch((err) => this.warnOnce("meta", err));
    this.session = s;
    // 성공 뒤에 지운다 — mkdir 이 던지면 신원은 남아 다음 이벤트가 재시도한다.
    this.pendingIdentity = null;
    return s;
  }

  private async writeMeta(s: SessionState, identity: SpoolIdentity | null): Promise<void> {
    const meta = {
      schema_version: SPOOL_SCHEMA_VERSION,
      session_id: s.id,
      user: identity,
      app_version: this.env.appVersion,
      os: this.env.os,
      ...(this.env.devHost ? { dev: true } : {}),
      started_at: s.startedAt,
    };
    const target = path.join(s.dir, "session.meta.json");
    const tmp = `${target}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(meta, null, 2) + "\n", "utf8");
    await renameWithRetry(tmp, target);
    s.metaWritten = true;
  }

  private async writeEvent(s: SessionState, fields: Record<string, unknown>): Promise<void> {
    if (!s.metaWritten) {
      // materialize/후착에서 meta 가 실패했던 세션 — 조용히 회복 시도.
      await this.writeMeta(s, s.identity).catch((err) => this.warnOnce("meta", err));
    }
    const record = { schema_version: SPOOL_SCHEMA_VERSION, ts: this.now().toISOString(), ...fields };
    const line = JSON.stringify(record) + "\n";
    const file = path.join(s.dir, "events.jsonl");
    try {
      await fs.promises.appendFile(file, line, "utf8");
    } catch (err) {
      // 세션 디렉토리가 밑에서 사라진 경우(다른 창의 보존 스윕 등) — 되살려서
      // 한 번 재시도한다. 안 하면 이 세션의 남은 이벤트가 전부 무음 유실된다.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      await fs.promises.mkdir(s.dir, { recursive: true });
      s.metaWritten = false;
      await this.writeMeta(s, s.identity).catch(() => undefined);
      await fs.promises.appendFile(file, line, "utf8");
    }
  }

  private warnOnce(what: string, err: unknown): void {
    if (this.warnedReasons.has(what)) return;
    this.warnedReasons.add(what);
    console.warn(`[spool] ${what} failed — 이 활성화의 로컬 로그는 불완전할 수 있다:`, err);
  }
}

function sameIdentity(a: SpoolIdentity, b: SpoolIdentity): boolean {
  return a.u === b.u && a.c === b.c && (a.p ?? "") === (b.p ?? "");
}

function numeric(v: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** workflow payload 의 문자열 값을 캡 — 웹뷰발 자유 텍스트(taskLabel 등) 방어. */
function clampPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] = typeof v === "string" && v.length > WORKFLOW_TEXT_CHARS
      ? v.slice(0, WORKFLOW_TEXT_CHARS)
      : v;
  }
  return out;
}

/**
 * win32 의 %APPDATA% 밑 rename 은 Defender/인덱서가 대상 파일을 잡고 있는
 * 동안 EPERM/EBUSY 로 일시 실패한다(graceful-fs 가 존재하는 이유). 한 번
 * 물러났다 재시도하고, 끝내 실패하면 .tmp 를 치우고 던진다 — 고아 .tmp 를
 * 남기면 업로더가 밟는다.
 */
async function renameWithRetry(tmp: string, target: string): Promise<void> {
  try {
    await fs.promises.rename(tmp, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") {
      await fs.promises.unlink(tmp).catch(() => undefined);
      throw err;
    }
    await new Promise((r) => setTimeout(r, 100));
    try {
      await fs.promises.rename(tmp, target);
    } catch (err2) {
      await fs.promises.unlink(tmp).catch(() => undefined);
      throw err2;
    }
  }
}

/**
 * 디렉토리는 로컬 날짜로 판다 — 강의장(KST) 저녁 수업이 UTC 로 어제 폴더에
 * 들어가면 사람이 못 찾는다. 레코드 ts 는 반대로 항상 ISO UTC (모호함 제거).
 */
function localDateStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function cryptoRandomUUID(): string {
  // node:crypto 의 randomUUID — 전역 crypto 는 Node 18+ 에 있다.
  return (globalThis.crypto as { randomUUID(): string }).randomUUID();
}

async function listSessionDirs(root: string): Promise<Array<{ dir: string; day: string }>> {
  const out: Array<{ dir: string; day: string }> = [];
  const days = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const day of days) {
    if (!day.isDirectory()) continue;
    const dayDir = path.join(root, day.name);
    const sessions = await fs.promises.readdir(dayDir, { withFileTypes: true }).catch(() => []);
    for (const s of sessions) {
      if (s.isDirectory()) out.push({ dir: path.join(dayDir, s.name), day: day.name });
    }
  }
  return out;
}

/** 평평한 세션 디렉토리 전제(파일만) — 하위 디렉토리가 생기면 재귀로 바꿀 것. */
async function dirSize(dir: string): Promise<{ bytes: number; mtimeMs: number }> {
  let bytes = 0;
  let mtimeMs = 0;
  const files = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const f of files) {
    const p = path.join(dir, f.name);
    const st = await fs.promises.stat(p).catch(() => null);
    if (!st) continue;
    if (st.isFile()) bytes += st.size;
    if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
  }
  return { bytes, mtimeMs };
}
