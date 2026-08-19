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
  opts?: { currentSessionDir?: string | null },
): UploadableSession[] {
  const out: UploadableSession[] = [];
  const days = readDirSafe(root);
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.name) || !day.isDirectory()) continue;
    const dayDir = path.join(root, day.name);
    for (const s of readDirSafe(dayDir)) {
      if (!s.isDirectory()) continue;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.name)) continue;
      const dir = path.join(dayDir, s.name);
      if (opts?.currentSessionDir && dir === opts.currentSessionDir) continue;
      if (!fs.existsSync(path.join(dir, "events.jsonl"))) continue;
      if (fs.existsSync(path.join(dir, UPLOADED_MARKER))) continue;
      out.push({ dir, day: day.name, sessionId: s.name });
    }
  }
  return out;
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

  // 존재하는 파일만 순서대로 — meta 는 이론상 없을 수 있고(쓰기 실패 세션),
  // events 는 스캔 조건이라 항상 있다.
  const present = UPLOAD_FILES_IN_ORDER.filter((f) => fs.existsSync(path.join(session.dir, f)));
  for (const name of present) {
    const body = fs.readFileSync(path.join(session.dir, name));
    const contentType = name.endsWith(".jsonl") ? "application/x-ndjson" : "application/json";
    const r = await putFile(name, body, contentType);
    if (!r.ok) {
      return { dir: session.dir, ok: false, keys, failedAt: name, status: r.status, message: r.message };
    }
  }

  const { bytes } = buildManifest(session.dir, present, now);
  const r = await putFile("manifest.json", bytes, "application/json");
  if (!r.ok) {
    return { dir: session.dir, ok: false, keys, failedAt: "manifest.json", status: r.status, message: r.message };
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
  opts: Omit<UploadSessionArgs, "session"> & { currentSessionDir?: string | null },
): Promise<SessionUploadResult[]> {
  const sessions = scanUploadableSessions(root, { currentSessionDir: opts.currentSessionDir });
  const results: SessionUploadResult[] = [];
  for (const session of sessions) {
    results.push(await uploadSession({ ...opts, session }));
  }
  return results;
}

function readDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
