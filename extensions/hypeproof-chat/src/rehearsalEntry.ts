// #1132 — 리허설 링크를 받는 자리. 순수 로직은 rehearsalEntryHelpers.ts 에 있다.
//
// 흐름: 링크 → 교환권 하나만 꺼냄 → Service 에 제출 → 학생 조건 자격을 받음 →
// 기존 참여 경로로 그 수업을 연다. 저장·판정은 전부 Service 다.
//
// 확인 다이얼로그에 대하여: **붙지 않는다.** 코드와 측정이 같은 답을 낸다.
// 코드 — 경고 모달은 `getWindowOpenableFromProtocolUrl` 이 값을 돌려줄 때만 닿는데 그 함수는
// authority 가 `file`/`vscode-remote` 인 경우에만 값을 내고, `shouldBlockOpenable` 안에도
// 같은 조건이 한 번 더 있다. 확장 authority 인 이 링크는 두 겹 모두에서 배제된다.
// 측정 — 출하 v0.1.56 에서 메인 프로세스의 `dialog.showMessageBox` 를 가로채 세었다.
// 양성 대조(`…://file/<경로>`)는 0→1 로 늘었고 확장 authority 는 1→1 로 안 늘었다.
// **한계**: URL 을 Electron `open-url` 로 합성해 넣었으므로 브라우저 클릭 전체 경로가 아니고,
// 출하 빌드로 쟀으므로 라우팅을 잰 것이지 이 핸들러를 잰 것이 아니다. 자세한 것과 남은
// 확인은 `docs/design/rehearsal-entry-failure-paths.md` §4 에 있다.
// 그래서 다이얼로그가 뜨는 것을 전제한 코드는 두지 않는다. 뒤집히면 문구가 하나 는다.

import * as vscode from "vscode";
import {
  parseFailureMessage,
  parseRehearsalUri,
  redeemRehearsalTicket,
} from "./rehearsalEntryHelpers";

/**
 * URI 핸들러를 등록한다. 이 확장에는 지금까지 이 등록이 **0건**이었고, 그래서
 * `hypeproof-studio://…` 링크가 아무 일도 하지 않았다.
 */
export function registerRehearsalUriHandler(
  context: vscode.ExtensionContext,
  deps: {
    proxyUrl: () => string;
    /** 받은 학생 조건 자격으로 그 수업을 여는 기존 경로. */
    connectWithToken: (token: string) => Promise<void>;
    notifyProblem?: (message: string) => void;
  },
): void {
  const warn = deps.notifyProblem ?? ((m: string) => void vscode.window.showWarningMessage(m));
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri): Promise<void> {
        const parsed = parseRehearsalUri({ path: uri.path, query: uri.query });
        if (!parsed.ok) { warn(parseFailureMessage(parsed)); return; }
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "리허설을 준비하는 중입니다…" },
          () => redeemRehearsalTicket({ proxyUrl: deps.proxyUrl(), ticket: parsed.ticket }),
        );
        if (!result.ok) { warn(result.failure.friendly); return; }
        await deps.connectWithToken(result.token);
      },
    }),
  );
}
