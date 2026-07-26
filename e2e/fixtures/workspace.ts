// 하네스 실행 전 워크스페이스 초기화.
//
// 왜 필요한가. 스펙들이 코호트 워크스페이스(~/HypeProofClinic)에서 돌기 때문에
// 이전 런이나 실사용의 산출물이 남아 있으면 **측정이 오염된다**:
//
//   agent.md 가 남아 있다        → B6 가 "코치가 만들었다" 로 오판
//   about.html 등이 남아 있다     → A1 이 남의 산출물을 채점
//   index.html 이 남아 있다       → "만들었는가" 가 "이미 있었는가" 와 구분 안 됨
//
// 2026-07-26 실측에서 실제로 그런 상태였다 — 실사용 세션의 파일 5개가 남은 채로
// 스위트가 돌았다.
//
// 안전 가드가 핵심이다. 스펙은 **코치가 말한 경로**를 쓰는데, 코치가 경로를
// 틀리게 말한 적이 있다(같은 날, find ~ 로 홈 전체를 뒤졌다). 그 값을 그대로
// 믿고 지우면 홈 디렉터리를 날린다. 그래서 지우기 전에 경로 모양을 검사하고,
// 통과하지 못하면 **지우지 않고 소리 나게 알린다.**

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 이 경로를 비워도 되는가.
 *
 * 허용: 홈 아래 `HypeProof*` 폴더, 또는 시스템 임시 디렉터리 아래.
 * 그 외에는 전부 거부한다 — 홈 루트·`/`·`/Users` 같은 값이 넘어오는 것이
 * 현실적인 실패 모드다.
 */
export function isWipeableWorkspace(dir: string): boolean {
  if (!dir || !path.isAbsolute(dir)) return false;
  const real = (() => {
    try { return fs.realpathSync(dir); } catch { return dir; }
  })();
  const home = fs.realpathSync(os.homedir());
  const tmp = fs.realpathSync(os.tmpdir());

  if (real === home || real === "/" || real === path.dirname(home)) return false;

  // 홈 바로 아래의 HypeProof* 폴더 (코호트 워크스페이스)
  if (path.dirname(real) === home && path.basename(real).startsWith("HypeProof")) return true;
  // 임시 디렉터리 아래 (e2e 픽스처가 만든 워크스페이스)
  if (real.startsWith(tmp + path.sep)) return true;

  return false;
}

/**
 * 워크스페이스를 비운다. 지운 목록을 돌려주고 콘솔에도 남긴다 — 조용히 지우면
 * 나중에 "왜 없어졌지"를 못 밝힌다(2026-07-26 에 실제로 그 질문이 나왔다).
 *
 * 거부되면 아무것도 지우지 않고 null 을 돌려준다. 호출부는 그 상태를 그대로
 * 보고해야 한다 — 더러운 워크스페이스로 잰 결과는 신뢰할 수 없다.
 */
export function resetWorkspace(dir: string): string[] | null {
  if (!isWipeableWorkspace(dir)) {
    console.log(`[ws] ⚠ 초기화 거부 — 안전하지 않은 경로: ${dir}`);
    return null;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    console.log(`[ws] 초기화 대상 없음 (읽을 수 없음): ${dir}`);
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    if (name === "." || name === "..") continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed.push(name);
    } catch (e) {
      console.log(`[ws] 삭제 실패 ${name}: ${String(e)}`);
    }
  }
  console.log(
    removed.length
      ? `[ws] 초기화: ${dir} — ${removed.length}개 삭제 (${removed.join(", ")})`
      : `[ws] 초기화: ${dir} — 이미 비어 있음`,
  );
  return removed;
}
