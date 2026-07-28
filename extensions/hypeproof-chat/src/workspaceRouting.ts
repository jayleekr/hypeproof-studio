// 코호트가 지정한 작업 폴더로 창을 옮길지 판정한다. Pure + vscode-free 라서
// 규칙 전체가 유닛 테스트로 잠긴다 (강의 당일 재현에 기대지 않는다).
//
// 왜 필요한가 (#422 이후 남은 구멍).
//
// `ensureWorkspace` 는 폴더가 이미 열려 있으면 즉시 no-op 이었다. 그런데 VS Code
// 는 마지막 창 상태를 복원하므로, 한 번 `~/HypeProofGames` 가 열리면 그 뒤로
// **다른 코호트 토큰을 넣어도 폴더가 영영 안 바뀐다**. 코치 cwd 는 "열린 폴더
// 우선"(chatPanelProvider.resolveCoachCwd)이라 프로필의 `workspace_root` 가 아니라
// 옛 폴더를 쓰게 되고, 성인 코호트(`~/HypeProofClinic`)가 아이들 게임 폴더에서
// 수업을 하게 된다. 실측: 2026-07-24 에 만들어진 `~/HypeProofGames` 가 그대로 남아
// 이후 모든 세션을 가로챘다.
//
// 그래서 진입 시점에 프로필이 다른 폴더를 지정하면 **자동으로 갈아탄다**.
//
// 무한 리로드가 이 기능의 진짜 위험이다 — `openFolder` 는 창을 리로드하고,
// 리로드 후 activate 가 다시 돌아 또 판정한다. 비교가 조금만 어긋나도(대소문자,
// 드라이브 문자, 후행 구분자, 심링크) 학생 기기가 수업 중에 리로드 루프에 빠진다.
// 방어는 두 겹이다:
//   1. 동일성 판정을 `path.relative(a, b) === ""` 로 한다 — win32 에서 대소문자와
//      드라이브 문자 차이를 흡수하고, canonicalize 주입(realpath)으로 심링크까지
//      흡수한다 (#384 에서 심링크 워크스페이스에 데인 적이 있다);
//   2. 호출부가 전환 직전에 목적지를 globalState 에 기록하고, 리로드 후 목적지가
//      안 열렸으면 **재시도하지 않는다**. 실패는 한 번으로 끝난다.

import * as path from "node:path";

export type WorkspaceSwitchDecision =
  /** 지금 열린 폴더를 그대로 쓴다. */
  | { switch: false; reason: string }
  /** `to` 로 창을 옮긴다. */
  | { switch: true; to: string; from: string };

export interface WorkspaceSwitchInput {
  /** 지금 열린 워크스페이스 폴더들의 fsPath (없으면 빈 배열). */
  openFolders: readonly string[];
  /**
   * 프로필의 `workspace_root` 를 절대경로로 푼 값. 상대경로·빈 값이라 신뢰할 수
   * 없으면 null — 그 경우 전환하지 않는다 (잘못 쓴 프로필이 창을 흔들 수 없다).
   */
  desiredRoot: string | null;
  /**
   * 직전 전환에서 기록해 둔 목적지. 리로드 후에도 목적지가 안 열려 있으면
   * 전환이 실패한 것이므로 **다시 시도하지 않는다** (리로드 루프 차단).
   */
  lastAttemptedRoot?: string | null;
  /**
   * e2e 는 폴더를 미리 열고 시작한다 (#42). 강제로 갈아치우면 스위트 전체가
   * 깨지므로 테스트 런에서는 전환을 하지 않는다.
   */
  isE2E?: boolean;
  /** realpath 계열 정규화. 기본은 항등 (유닛 테스트는 fs 를 안 탄다). */
  canonicalize?: (p: string) => string;
}

/** 두 경로가 같은 위치를 가리키나? win32 대소문자/드라이브 문자까지 흡수한다. */
export function isSameLocation(
  a: string,
  b: string,
  canonicalize: (p: string) => string = (p) => p,
): boolean {
  try {
    return path.relative(canonicalize(a), canonicalize(b)) === "";
  } catch {
    return false;
  }
}

/**
 * 진입 시점에 코호트 폴더로 갈아탈지 판정한다.
 *
 * 전환하지 않는 경우 (전부 의도적):
 *   - 열린 폴더가 없다 → 전환이 아니라 최초 open 경로다 (호출부가 처리);
 *   - 프로필이 폴더를 지정하지 않았거나 절대경로로 풀리지 않는다;
 *   - 이미 그 폴더가 열려 있다;
 *   - 멀티루트 창에서 목적지가 이미 루트 중 하나다 — 강사가 일부러 구성한 창을
 *     단일 루트로 접지 않는다;
 *   - 직전 전환 시도의 목적지와 같다 → 실패했다는 뜻, 재시도 금지;
 *   - e2e 런.
 */
export function decideWorkspaceSwitch(input: WorkspaceSwitchInput): WorkspaceSwitchDecision {
  const canon = input.canonicalize ?? ((p: string) => p);
  const { openFolders, desiredRoot } = input;

  if (openFolders.length === 0) return { switch: false, reason: "no folder open (initial open path)" };
  if (!desiredRoot) return { switch: false, reason: "profile has no usable workspace_root" };
  if (input.isE2E) return { switch: false, reason: "e2e run — the fixture owns the folder" };

  if (openFolders.some((f) => isSameLocation(f, desiredRoot, canon))) {
    return { switch: false, reason: "cohort folder is already open" };
  }

  // 리로드 루프 차단. 목적지가 안 열린 채 같은 목적지를 또 시도한다는 것은 직전
  // openFolder 가 실패했다는 뜻이다. 한 번 더 시도해도 같은 결과다.
  if (input.lastAttemptedRoot && isSameLocation(input.lastAttemptedRoot, desiredRoot, canon)) {
    return { switch: false, reason: "already attempted this root and it did not open — not retrying" };
  }

  return { switch: true, to: desiredRoot, from: openFolders[0]! };
}
