// #1132 — 리허설 링크를 받는 자리. 순수 로직은 rehearsalEntryHelpers.ts 에 있다.
//
// 흐름: 링크 → 교환권 하나만 꺼냄 → Service 에 제출 → 학생 조건 자격을 받음 →
// 기존 참여 경로로 그 수업을 연다. 저장·판정은 전부 Service 다.
//
// 확인 다이얼로그에 대하여: 출하된 v0.1.56 번들(`out/main.js`)을 읽어 확인한 바,
// 프로토콜 URL 의 경고 모달은 `getWindowOpenableFromProtocolUrl` 이 값을 돌려줄 때만
// 닿는데 그 함수는 authority 가 `file`/`vscode-remote` 인 경우에만 값을 낸다.
// `shouldBlockOpenable` 안에도 같은 조건이 한 번 더 있다. 확장 authority 인 이 링크는
// 두 겹 모두에서 배제되므로 **확인 한 번이 붙지 않는다.**
// 근거는 코드이고 **실기기 미확인이다**(관측 시도가 꺼진 디스플레이로 무산됐다).
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
