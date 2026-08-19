// #596 — 스풀 업로더 (#580 업로드 계층의 클라이언트 절반).
//
// 로컬 스풀 세션 디렉토리를 worker 의 PUT /v1/logs/<sessionId>/<filename>
// 으로 파일 단위 적재한다. 규약:
//
// - **manifest 는 마지막에** 올린다 — 서버 쪽에서 manifest 가 있는 세션만
//   완결로 친다. 중간에 끊기면 manifest 없는 채로 남고, 다음 트리거가
//   전체를 다시 올린다(R2 put 은 덮어쓰기 = 멱등).
// - 성공한 세션에는 로컬 마커 `uploaded.json` 을 남긴다 — 스캔이 건너뛰고,
//   보존 정리(sessionSpool.sweepRetention)가 N일 뒤 지운다.
// - vscode 를 import 하지 않는다 — test/spool-uploader.smoke.mjs 가 플레인
//   Node + 주입 fetch 로 검증한다 (sessionSpool.ts 와 같은 규율).
// - 업로더는 스풀과 달리 실패를 삼키지 않는다 — 명시적 사용자 액션의
//   결과이므로 구조화된 결과를 돌려주고 UI 가 보여준다.

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

export const UPLOADED_MARKER = "uploaded.json";
export const MANIFEST_SCHEMA_VERSION = 1;

/** 업로드 대상 파일 — 서버 allowlist(routes/logs.ts)와 정합. 순서가 곧 프로토콜. */
const UPLOAD_FILES_IN_ORDER = ["session.meta.json", "events.jsonl"] as const;

/**
 * 서버 allowlist(routes/logs.ts ALLOWED_UPLOAD_FILENAMES)와의 드리프트 락
 * 테스트용 — 클라가 올리는 파일명 전집합. 두 목록이 어긋나면 세션이 조용히
 * 미완결로만 남는다(400 → manifest 미도달).
 */
export const CLIENT_UPLOAD_FILENAMES = [...UPLOAD_FILES_IN_ORDER, "manifest.json"];

/**
 * 정지(quiescence) 게이트 — events.jsonl 이 이 시간 안에 갱신된 세션은
 * "아직 쓰는 중"으로 보고 건너뛴다. 같은 PC 의 **다른 창**이 소유한 활성
 * 세션을 집어 올리는 것을 막는다(1회차 리뷰 F2: 거짓 manifest + 마커로
 * 꼬리 영구 유실). 이 인스턴스가 방금 봉인한 세션은 allowFresh 로 예외 —
 * 봉인 = 더 이상 쓰지 않는다는 자기 보증이다.
 */
export const UPLOAD_QUIESCENT_MS = 5 * 60 * 1000;

export interface UploadableSession {
  dir: string;
  /** 날짜 디렉토리명 (yyyy-mm-dd) — R2 키의 <day> 조각. */
  day: string;
  /** 세션 디렉토리명 (UUID) — R2 키의 <sessionId> 조각. */
  sessionId: string;
}

export interface SessionUploadResult {
  dir: string;
  ok: boolean;
  /** 서버가 돌려준 R2 키들 (성공분). */
  keys: string[];
  /** 실패 시 — 어느 파일에서, 어떤 상태/메시지로 멈췄는지. */
  failedAt?: string;
  status?: number;
  message?: string;
}

/**
 * 업로드할 세션을 찾는다: events.jsonl 이 있고, 아직 마커가 없고, 현재
 * 활성 세션이 아닌 것. 날짜/세션id 형식이 어긋난 디렉토리(수동 생성물 등)는
 * 조용히 건너뛴다 — 서버가 어차피 400 으로 거부할 키다.
 */
export function scanUploadableSessions(
  root: string,
  opts?: {
    currentSessionDir?: string | null;
    /** 이 인스턴스가 방금 봉인한 디렉토리 — 정지 게이트 면제 (자기 보증). */
    allowFresh?: readonly string[];
    /**
     * 현재 토큰의 신원 — 주어지면 meta 의 user 가 **정확히 일치하는** 세션만
     * 올린다. 공용 PC 에서 학생 B 의 클릭이 학생 A 의 원문을 B 의 프리픽스·
     * B 의 코호트 동의 아래 올리는 것을 막는다(2회차 리뷰 N2). user:null
     * (토큰 전 익명 세션)도 건너뛴다 — 귀속 없는 원문은 내보내지 않는다.
     */
    identity?: { u: string; c: string } | null;
    now?: () => Date;
  },
): UploadableSession[] {
  const out: UploadableSession[] = [];
  const nowMs = (opts?.now ?? (() => new Date()))().getTime();
  const allowFresh = new Set(opts?.allowFresh ?? []);
  const days = readDirSafe(root);
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.name) || !day.isDirectory()) continue;
    const dayDir = path.join(root, day.name);
    for (const s of readDirSafe(dayDir)) {
      if (!s.isDirectory()) continue;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.name)) continue;
      const dir = path.join(dayDir, s.name);
      if (opts?.currentSessionDir && dir === opts.currentSessionDir) continue;
      const eventsStat = statSafe(path.join(dir, "events.jsonl"));
      if (!eventsStat) continue;
      if (fs.existsSync(path.join(dir, UPLOADED_MARKER))) continue;
      // 정지 게이트 — 다른 창의 활성 세션 보호 (UPLOAD_QUIESCENT_MS 주석).
      if (!allowFresh.has(dir) && nowMs - eventsStat.mtimeMs < UPLOAD_QUIESCENT_MS) continue;
      if (opts?.identity) {
        const user = readMetaUser(dir);
        if (!user || user.u !== opts.identity.u || user.c !== opts.identity.c) continue;
      }
      out.push({ dir, day: day.name, sessionId: s.name });
    }
  }
  return out;
}

/** session.meta.json 의 user — 없거나 깨졌으면 null (귀속 불가 = 업로드 제외). */
function readMetaUser(dir: string): { u: string; c: string } | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "session.meta.json"), "utf8")) as {
      user?: { u?: unknown; c?: unknown } | null;
    };
    const u = meta.user?.u;
    const c = meta.user?.c;
    return typeof u === "string" && typeof c === "string" ? { u, c } : null;
  } catch {
    return null;
  }
}

/** 파일 목록 + sha256 — 서버 쪽 무결성 검증과 부분 업로드 판별의 근거. */
export function buildManifest(
  dir: string,
  files: readonly string[],
  now: () => Date,
): { manifest: Record<string, unknown>; bytes: Buffer } {
  const entries = [];
  for (const name of files) {
    const buf = fs.readFileSync(path.join(dir, name));
    entries.push({
      name,
      bytes: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
    });
  }
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    session_id: path.basename(dir),
    created_at: now().toISOString(),
    files: entries,
  };
  return { manifest, bytes: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8") };
}

export interface UploadSessionArgs {
  session: UploadableSession;
  /** proxyUrl 설정값 (…/v1 로 끝남) — /logs/… 를 여기에 붙인다. */
  baseUrl: string;
  token: string;
  /** 테스트 주입용. 기본 globalThis.fetch. */
  fetchFn?: typeof fetch;
  now?: () => Date;
}

/**
 * 세션 하나를 올린다: meta → events → (그 둘의 해시를 담은) manifest 순.
 * 어느 파일에서든 실패하면 거기서 멈춘다 — manifest 가 안 올라갔으므로
 * 서버 기준 미완결, 다음 트리거가 처음부터 다시 올린다(멱등).
 */
export async function uploadSession(args: UploadSessionArgs): Promise<SessionUploadResult> {
  const { session } = args;
  const fetchFn = args.fetchFn ?? fetch;
  const now = args.now ?? (() => new Date());
  const base = args.baseUrl.replace(/\/$/, "");
  const keys: string[] = [];

  const putFile = async (
    name: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<{ ok: true } | { ok: false; status: number; message: string }> => {
    const url = `${base}/logs/${session.sessionId}/${name}?day=${session.day}`;
    try {
      const res = await fetchFn(url, {
        method: "PUT",
        headers: { authorization: `Bearer ${args.token}`, "content-type": contentType },
        // Node 18+ fetch 는 Uint8Array body 를 그대로 받는다 — @types/node 의
        // fetch 시그니처에 BodyInit 이 없어 구조적 캐스트만 한다.
        body: body as unknown as RequestInit["body"],
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let message = `HTTP ${res.status}`;
        try {
          const j = JSON.parse(text) as { error?: { message?: string; type?: string } };
          if (j?.error?.message) message = j.error.message;
        } catch { /* 본문이 JSON 이 아니면 상태코드만 */ }
        return { ok: false, status: res.status, message };
      }
      const j = (await res.json().catch(() => null)) as { key?: string } | null;
      if (j?.key) keys.push(j.key);
      return { ok: true };
    } catch (err) {
      return { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) };
    }
  };

  // 파일 바이트를 **한 번만** 읽고, PUT 도 manifest 해시도 같은 버퍼에서
  // 만든다 — 읽기 두 번 사이에 다른 프로세스가 append 하면 manifest 가
  // "업로드된 적 없는 바이트"를 서술하는 거짓 완결이 된다(1회차 리뷰 F2).
  // fs 읽기 실패(스캔과 읽기 사이 삭제 등)도 구조화 실패로 — throw 전파는
  // REQ-Q11 계약 위반이다.
  let entries: Array<{ name: string; body: Buffer }>;
  try {
    entries = UPLOAD_FILES_IN_ORDER
      .filter((f) => fs.existsSync(path.join(session.dir, f)))
      .map((name) => ({ name, body: fs.readFileSync(path.join(session.dir, name)) }));
  } catch (err) {
    return {
      dir: session.dir, ok: false, keys, failedAt: "read",
      status: 0, message: err instanceof Error ? err.message : String(err),
    };
  }
  // events.jsonl 은 세션의 본체 — 스캔과 읽기 사이에 사라졌다면(다른 창의
  // 스윕 등) 빈 manifest 로 "완결"을 주장하면 안 된다.
  if (!entries.some((e) => e.name === "events.jsonl")) {
    return { dir: session.dir, ok: false, keys, failedAt: "read", status: 0, message: "events.jsonl missing" };
  }

  for (const { name, body } of entries) {
    const contentType = name.endsWith(".jsonl") ? "application/x-ndjson" : "application/json";
    const r = await putFile(name, body, contentType);
    if (!r.ok) {
      return { dir: session.dir, ok: false, keys, failedAt: name, status: r.status, message: r.message };
    }
  }

  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    session_id: session.sessionId,
    created_at: now().toISOString(),
    files: entries.map(({ name, body }) => ({
      name,
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const r = await putFile("manifest.json", manifestBytes, "application/json");
  if (!r.ok) {
    return { dir: session.dir, ok: false, keys, failedAt: "manifest.json", status: r.status, message: r.message };
  }

  // 2회차 리뷰 N1 — 업로드(수 초)가 도는 사이 피닝된 늦은 턴이 events 에
  // append 했을 수 있다. 그 상태로 마커를 쓰면 꼬리가 R2 에 없는 채 "완결"이
  // 되고 3일 뒤 스윕이 유일본을 지운다. 크기가 달라졌으면 마커를 **쓰지
  // 않는다** — 세션은 pending 으로 남아 다음 트리거가 전체를 다시 올린다(멱등).
  const eventsUploaded = entries.find((e) => e.name === "events.jsonl");
  const eventsNow = statSafe(path.join(session.dir, "events.jsonl"));
  if (!eventsNow || eventsNow.size !== (eventsUploaded?.body.length ?? -1)) {
    return {
      dir: session.dir, ok: true, keys,
      message: eventsNow
        ? "events grew during upload — 다음 트리거가 다시 올려요"
        : "events.jsonl vanished after upload — R2 본은 완결, 마커만 보류",
    };
  }

  // 완결 — 로컬 마커. 마커 쓰기 실패는 치명이 아니다(다음 트리거가 같은
  // 내용을 다시 올릴 뿐, R2 는 멱등) — 결과에는 성공으로 남긴다.
  try {
    fs.writeFileSync(
      path.join(session.dir, UPLOADED_MARKER),
      JSON.stringify({ schema_version: 1, at: now().toISOString(), keys }, null, 2) + "\n",
      "utf8",
    );
  } catch { /* best-effort */ }
  return { dir: session.dir, ok: true, keys };
}

/** 미업로드 세션 전부 순차 업로드. 하나가 실패해도 나머지는 계속 시도한다. */
export async function uploadAllPending(
  root: string,
  opts: Omit<UploadSessionArgs, "session"> & {
    currentSessionDir?: string | null;
    allowFresh?: readonly string[];
    identity?: { u: string; c: string } | null;
  },
): Promise<SessionUploadResult[]> {
  const sessions = scanUploadableSessions(root, {
    currentSessionDir: opts.currentSessionDir,
    allowFresh: opts.allowFresh,
    identity: opts.identity,
    now: opts.now,
  });
  const results: SessionUploadResult[] = [];
  for (const session of sessions) {
    try {
      results.push(await uploadSession({ ...opts, session }));
    } catch (err) {
      // uploadSession 은 던지지 않는 계약이지만, 계약이 뚫려도 나머지 세션과
      // 결과 안내는 살아야 한다 (belt-and-suspenders).
      results.push({
        dir: session.dir, ok: false, keys: [], failedAt: "unexpected",
        status: 0, message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function readDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
