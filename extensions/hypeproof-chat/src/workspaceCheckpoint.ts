// 작업 폴더 복구 지점 — 코치가 고치기 전으로 되돌린다 (#673, AE-15 / WEB-05).
//
// WHY
//   2026-08-22 SK바이오팜 1회차 오후 14:47 KST, 산출물 HTML 이 깨졌다. 깨진
//   자리의 아이에게 돌아갈 길이 없었고 강사도 손쓸 수단이 없었다.
//
//   있던 것은 `archiveCurrentWorld` 하나다. 그건 진짜 백업이지만 **덮어쓰기
//   경로에만** 걸린다: `shouldArchiveWorld` 가 "디스크 내용 ≠ 쓸 내용" 일 때만
//   보관하는데, SDK 코치의 Edit/Write 는 `revealWrittenHtml` 이 파일을 되읽기
//   **전에** 이미 바꿔 놓으므로 current === next 가 되어 정확히 건너뛴다
//   (chatPanelProvider.ts 의 revealBuilt 주석이 그 사실을 적고 있다).
//   그래서 "코치가 세상을 망가뜨림" 이라는 바로 그 시나리오에 스냅샷이 없었다.
//
//   그리고 복구 경로 자체가 없었다 — contributes.commands 18개 중 undo/restore 가
//   하나도 없고, `이전 세상/` 은 코치의 파일 목록에서 숨겨져 있어 코치조차 거기서
//   꺼내지 못한다. 복구는 프롬프트 산문("되돌리기")에, 즉 **코치가 기억해 주기를
//   바라는 것**에 전적으로 의존하고 있었다.
//
// WHAT THIS IS
//   파일 **집합**의 복구 지점이다. index.html 한 장이 아니다 — AE-15 가 요구하는
//   것은 추가·수정·삭제를 되돌리는 것이고, 코치는 셸로도 파일을 지운다.
//   캡처는 디스크를 그 자리에서 읽으므로 **아이가 손으로 고친 것도 그대로** 들어
//   온다(앱이 기억하는 모델이 아니라 실제 파일을 뜬다).
//
// WHAT THIS IS NOT — 그리고 이건 UI 가 말해야 한다
//   작업 폴더 밖은 복구하지 않는다. 갤러리에 올린 작품, GitHub Pages 에 배포된
//   사이트, 서버에 남은 기록은 되돌아가지 않는다. `notCoveredNotice()` 가 그
//   문장을 소유한다 — "전부 되돌렸다" 고 읽히는 화면이 이 기능의 가장 비싼
//   실패다(복구했다고 믿고 덮어쓰면 그때는 진짜로 끝이다).
//
// `vscode` 를 import 하지 않는다 — 확장 호스트는 Node 이고, 이 모듈이 순수
// node:fs 위에 서 있어야 대조군이 실제 파일시스템에서 돈다
// (test/workspace-checkpoint.smoke.mjs, workspacePreparation.ts 와 같은 방침).

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

/** 보관 폴더 이름 — chatPanelHelpers.WORLD_ARCHIVE_DIR 와 같은 값. 여기서
 * 다시 적는 이유는 그 모듈이 `vscode` 를 끌고 오기 때문이다. 두 곳이 갈라지면
 * 대조군이 잡는다(smoke 가 두 파일을 함께 읽는다). */
export const WORLD_ARCHIVE_DIR_NAME = "이전 세상";

export const CHECKPOINT_FORMAT = "hps-checkpoint/1" as const;

/** 한 번에 뜨는 양의 상한. 넘으면 **건너뛴 것을 기록하고** 그 사실을 말한다.
 * 조용히 자르면 "복구했다" 가 거짓이 된다. */
export const CHECKPOINT_LIMITS = {
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 2000,
  keep: 20,
};

/** 뜨지 않는 경로. 아이의 작업물이 아니거나(도구가 다시 만든다), 되돌릴 대상이
 * 아니다. */
export const CHECKPOINT_EXCLUDED_DIRS: readonly string[] = [
  ".git",
  "node_modules",
  ".DS_Store",
  ".vscode",
  "__pycache__",
];

/**
 * 복구가 **지우지 않는** 폴더. `이전 세상/` 은 그 자체가 복구 수단이다 —
 * 보관본보다 이전 시점으로 되돌린다고 해서 보관본을 지우면, 복구가 복구를 먹는다.
 * 없으면 되살리고, 있으면 그대로 둔다(추가 전용).
 */
export const RESTORE_PRESERVED_DIRS: readonly string[] = [WORLD_ARCHIVE_DIR_NAME];

export type SkipReason = "too_large" | "unreadable" | "budget" | "too_many";

export interface CheckpointFile {
  /** 작업 폴더 기준 상대 경로. 항상 `/` 구분자 (윈도우에서도 manifest 는 같은 글자). */
  path: string;
  sha256: string;
  size: number;
}

export interface SkippedFile {
  path: string;
  why: SkipReason;
  size?: number;
}

export type CheckpointReason = "before_turn" | "before_restore" | "manual";

export interface CheckpointManifest {
  format: typeof CHECKPOINT_FORMAT;
  id: string;
  createdAt: number;
  reason: CheckpointReason;
  label: string;
  workspace: string;
  files: CheckpointFile[];
  /** 담지 못한 것. 비어 있지 않으면 복구는 "완전 복구" 라고 말하지 않는다. */
  skipped: SkippedFile[];
}

export interface RestorePlan {
  /** 체크포인트에 있고 지금과 다른(또는 없는) 파일 — 되쓴다. */
  write: string[];
  /** 체크포인트에 없는데 지금 있는 파일 — 지운다(= 그 사이 추가된 것). */
  delete: string[];
  /** 지금 있지만 보존 폴더라 지우지 않는 것. 무엇을 **안** 했는지도 결과다. */
  preserved: string[];
  /** 이미 같은 파일. */
  unchanged: number;
}

// ---------------------------------------------------------------------------
// 순수 함수 — 파일시스템 없이 판정되는 부분
// ---------------------------------------------------------------------------

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** manifest 안의 경로 표기는 플랫폼과 무관해야 한다. */
export function toManifestPath(relative: string): string {
  return relative.split(path.sep).join("/");
}

export function isExcludedSegment(segment: string): boolean {
  return CHECKPOINT_EXCLUDED_DIRS.includes(segment);
}

export function isPreservedPath(manifestPath: string): boolean {
  const head = manifestPath.split("/")[0] ?? "";
  return RESTORE_PRESERVED_DIRS.includes(head);
}

/**
 * 되돌리기 계획. 순수 함수라 심은 두 파일 집합으로 바로 잰다.
 *
 * 삭제를 계획에 넣는 것이 이 기능의 핵심 절반이다 — AE-15 가 "추가·수정·삭제" 를
 * 함께 적은 이유가 그것이다. 수정만 되돌리면 코치가 만든 잡동사니가 남고, 아이는
 * 자기 폴더가 원래대로 왔는지 알 수 없다.
 */
export function planRestore(
  current: readonly CheckpointFile[],
  target: readonly CheckpointFile[],
): RestorePlan {
  const now = new Map(current.map((f) => [f.path, f.sha256]));
  const then = new Map(target.map((f) => [f.path, f.sha256]));
  const write: string[] = [];
  const del: string[] = [];
  const preserved: string[] = [];
  let unchanged = 0;

  for (const [p, hash] of then) {
    if (now.get(p) === hash) unchanged += 1;
    else write.push(p);
  }
  for (const p of now.keys()) {
    if (then.has(p)) continue;
    if (isPreservedPath(p)) preserved.push(p);
    else del.push(p);
  }
  write.sort();
  del.sort();
  preserved.sort();
  return { write, delete: del, preserved, unchanged };
}

/** 복구 지점 id — 사전순 = 시간순. 같은 밀리초 충돌은 꼬리로 가른다. */
export function checkpointId(at: Date, rand: () => string = () => Math.random().toString(36).slice(2, 8)): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-` +
    `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}${p(at.getMilliseconds(), 3)}-${rand()}`
  );
}

/**
 * 복구가 **덮지 않는** 범위. 승인 화면과 완료 안내가 이 문장을 그대로 쓴다.
 *
 * 문구 규칙은 REQ-M15/M30 과 같다: 원인을 단정하지 않고, 한 일과 안 한 일을
 * 구분해 말한다. 여기서 중요한 것은 **안 한 일**이다.
 */
export function notCoveredNotice(): string {
  return [
    "되돌리는 것은 이 작업 폴더의 파일뿐이에요.",
    "이미 인터넷에 올린 것(갤러리·웹사이트 주소)과 대화 기록은 그대로 남아요.",
  ].join(" ");
}

/** 사람이 읽는 복구 지점 이름. */
export function checkpointLabel(reason: CheckpointReason, at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const clock = `${p(at.getHours())}:${p(at.getMinutes())}`;
  if (reason === "before_restore") return `되돌리기 직전 (${clock})`;
  if (reason === "manual") return `직접 만든 저장점 (${clock})`;
  return `코치가 고치기 전 (${clock})`;
}

/** 복구 결과를 아이가 읽을 한 줄로. 건너뛴 것이 있으면 숨기지 않는다. */
export function restoreSummary(plan: RestorePlan, skipped: readonly SkippedFile[]): string {
  const parts: string[] = [];
  if (plan.write.length) parts.push(`${plan.write.length}개 되돌림`);
  if (plan.delete.length) parts.push(`${plan.delete.length}개 지움`);
  if (parts.length === 0) parts.push("바뀐 것이 없었어요");
  let line = `되돌렸어요 — ${parts.join(", ")}.`;
  if (plan.preserved.length) {
    line += ` 「${WORLD_ARCHIVE_DIR_NAME}」 폴더의 ${plan.preserved.length}개는 그대로 뒀어요.`;
  }
  if (skipped.length) {
    line += ` 너무 크거나 읽지 못한 파일 ${skipped.length}개는 이 저장점에 담기지 않았어요.`;
  }
  return `${line} ${notCoveredNotice()}`;
}

// ---------------------------------------------------------------------------
// 파일시스템 — 실제 폴더를 뜨고 되돌린다
// ---------------------------------------------------------------------------

export interface ScanResult {
  files: CheckpointFile[];
  skipped: SkippedFile[];
}

/**
 * 작업 폴더를 그 자리에서 읽는다. 앱이 기억하는 상태가 아니라 **디스크**를 뜨기
 * 때문에 아이의 수동 편집과 셸이 만든 파일이 자동으로 들어온다.
 *
 * 상한에 닿으면 멈추되 **건너뛴 것을 전부 기록한다**. 조용히 자르면 뒤에서
 * "복구했다" 가 거짓말이 된다.
 */
export function scanWorkspace(root: string, limits = CHECKPOINT_LIMITS): ScanResult {
  const files: CheckpointFile[] = [];
  const skipped: SkippedFile[] = [];
  let total = 0;

  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped.push({ path: prefix || ".", why: "unreadable" });
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (isExcludedSegment(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      // 심볼릭 링크는 따라가지 않는다. 따라가면 작업 폴더 밖을 뜨게 되고,
      // 되돌릴 때 폴더 밖을 쓰게 된다 — 그건 이 기능이 해도 되는 일이 아니다.
      if (entry.isSymbolicLink()) {
        skipped.push({ path: rel, why: "unreadable" });
        continue;
      }
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= limits.maxFiles) {
        skipped.push({ path: rel, why: "too_many" });
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        skipped.push({ path: rel, why: "unreadable" });
        continue;
      }
      if (stat.size > limits.maxFileBytes) {
        skipped.push({ path: rel, why: "too_large", size: stat.size });
        continue;
      }
      if (total + stat.size > limits.maxTotalBytes) {
        skipped.push({ path: rel, why: "budget", size: stat.size });
        continue;
      }
      let buf: Buffer;
      try {
        buf = fs.readFileSync(abs);
      } catch {
        skipped.push({ path: rel, why: "unreadable" });
        continue;
      }
      total += buf.length;
      files.push({ path: toManifestPath(rel), sha256: sha256(buf), size: buf.length });
    }
  };

  walk(root, "");
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, skipped };
}

/** 저장소 레이아웃: <store>/<workspaceKey>/{blobs,<id>.json} */
export function workspaceKey(root: string): string {
  return sha256(path.resolve(root)).slice(0, 16);
}

function storeDir(store: string, root: string): string {
  return path.join(store, workspaceKey(root));
}

/**
 * 지금 폴더를 복구 지점으로 뜬다.
 *
 * 내용 주소(sha256) 로 저장하므로 안 바뀐 파일은 다시 쓰지 않는다 — 한 턴마다
 * 폴더 전체를 복사하면 아이 노트북에서 금방 몇 GB 가 된다.
 */
export function captureCheckpoint(args: {
  root: string;
  store: string;
  reason: CheckpointReason;
  now?: Date;
  limits?: typeof CHECKPOINT_LIMITS;
}): CheckpointManifest {
  const now = args.now ?? new Date();
  const limits = args.limits ?? CHECKPOINT_LIMITS;
  const dir = storeDir(args.store, args.root);
  const blobs = path.join(dir, "blobs");
  fs.mkdirSync(blobs, { recursive: true });

  const { files, skipped } = scanWorkspace(args.root, limits);
  for (const f of files) {
    const blob = path.join(blobs, f.sha256);
    if (fs.existsSync(blob)) continue;
    fs.writeFileSync(blob, fs.readFileSync(path.join(args.root, ...f.path.split("/"))));
  }

  const manifest: CheckpointManifest = {
    format: CHECKPOINT_FORMAT,
    id: checkpointId(now),
    createdAt: now.getTime(),
    reason: args.reason,
    label: checkpointLabel(args.reason, now),
    workspace: path.resolve(args.root),
    files,
    skipped,
  };
  fs.writeFileSync(path.join(dir, `${manifest.id}.json`), JSON.stringify(manifest), "utf8");
  pruneCheckpoints(args.store, args.root, limits.keep);
  return manifest;
}

/** 최신 순. 읽을 수 없거나 형식이 다른 manifest 는 조용히 건너뛴다 — 하나가
 * 깨졌다고 목록 전체를 잃으면 복구 수단이 통째로 사라진다. */
export function listCheckpoints(store: string, root: string): CheckpointManifest[] {
  const dir = storeDir(store, root);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: CheckpointManifest[] = [];
  for (const name of names) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as CheckpointManifest;
      if (m?.format === CHECKPOINT_FORMAT && Array.isArray(m.files)) out.push(m);
    } catch {
      /* 깨진 한 건은 건너뛴다 */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

/** 오래된 복구 지점을 버리고, 아무도 안 쓰는 blob 을 지운다. */
export function pruneCheckpoints(store: string, root: string, keep = CHECKPOINT_LIMITS.keep): void {
  const dir = storeDir(store, root);
  const all = listCheckpoints(store, root);
  for (const m of all.slice(keep)) {
    try {
      fs.rmSync(path.join(dir, `${m.id}.json`));
    } catch {
      /* 이미 없음 */
    }
  }
  const live = new Set(listCheckpoints(store, root).flatMap((m) => m.files.map((f) => f.sha256)));
  const blobs = path.join(dir, "blobs");
  let names: string[];
  try {
    names = fs.readdirSync(blobs);
  } catch {
    return;
  }
  for (const n of names) {
    if (live.has(n)) continue;
    try {
      fs.rmSync(path.join(blobs, n));
    } catch {
      /* 경쟁 — 다음 정리에서 다시 본다 */
    }
  }
}

export interface RestoreResult {
  ok: boolean;
  plan: RestorePlan;
  /** 되돌리기 **직전** 상태를 담은 복구 지점 (AE-15: 복구 직전 상태도 보존). */
  safety: CheckpointManifest | null;
  /** 복구한 지점에 애초에 담기지 못했던 것 — 그대로 들고 다닌다. */
  skipped: SkippedFile[];
  failed: string[];
  message: string;
}

/**
 * 되돌린다.
 *
 * 순서가 계약이다: **먼저 지금 상태를 뜨고**(safety) 그 다음에 쓴다. 되돌리기
 * 자체가 되돌릴 수 없는 행위이면 아무것도 고친 게 아니다 — 아이가 "그거 말고
 * 아까 거" 라고 말할 자리가 있어야 한다.
 */
export function restoreCheckpoint(args: {
  root: string;
  store: string;
  id: string;
  now?: Date;
  limits?: typeof CHECKPOINT_LIMITS;
}): RestoreResult {
  const limits = args.limits ?? CHECKPOINT_LIMITS;
  const target = listCheckpoints(args.store, args.root).find((m) => m.id === args.id);
  if (!target) {
    const empty: RestorePlan = { write: [], delete: [], preserved: [], unchanged: 0 };
    return { ok: false, plan: empty, safety: null, skipped: [], failed: [], message: "그 저장점을 찾지 못했어요." };
  }

  const safety = captureCheckpoint({
    root: args.root,
    store: args.store,
    reason: "before_restore",
    ...(args.now ? { now: args.now } : {}),
    limits,
  });
  const plan = planRestore(safety.files, target.files);

  const blobs = path.join(storeDir(args.store, args.root), "blobs");
  const byPath = new Map(target.files.map((f) => [f.path, f]));
  const failed: string[] = [];

  for (const rel of plan.write) {
    const file = byPath.get(rel);
    if (!file) continue;
    const dest = path.join(args.root, ...rel.split("/"));
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, fs.readFileSync(path.join(blobs, file.sha256)));
    } catch {
      failed.push(rel);
    }
  }
  for (const rel of plan.delete) {
    try {
      fs.rmSync(path.join(args.root, ...rel.split("/")), { force: true });
    } catch {
      failed.push(rel);
    }
  }

  const message = failed.length
    ? `${restoreSummary(plan, target.skipped)} ${failed.length}개는 되돌리지 못했어요.`
    : restoreSummary(plan, target.skipped);
  return { ok: failed.length === 0, plan, safety, skipped: target.skipped, failed, message };
}
