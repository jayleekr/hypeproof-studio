// 강사가 Chalk 면에서 학생 조건으로 들어가고 돌아온다 (#1205, RUN-01 · ARC-03).
//
// 순수 로직은 rehearsalSessionHelpers.ts 에 있다. 여기는 vscode 배선뿐이다.
//
// ── 왜 딥링크가 아닌가 ───────────────────────────────────────────────────
// 강사와 학생이 같은 앱이라 앱 밖으로 나갈 일이 없다. 그리고 실측으로 닫혔다:
// Dev 앱은 `CFBundleURLTypes` 가 제거돼 URL 핸들러로 등록되지 않는다
// (`docs/design/rehearsal-entry-dev-deeplink-survey.md`). 교환권은 **남긴다** —
// 없애면 `ARC-03` 의 "한 번만 통과" 가 사라진다. URL 만 없앴다.
//
// ── 자격이 어디서 오는가 (이 파일의 핵심) ────────────────────────────────
// 리허설 중 채팅·도구 요청은 이 파일이 헤더를 만들지 **않는다.** 기존 경로가
// `context.secrets.get(TOKEN_KEY)` 하나에서 자격을 읽어 가고, 우리가 하는 일은
// 그 자리에 좌석 토큰을 **앉히는 것**뿐이다. issuer 는 다른 키
// (`ISSUER_TOKEN_KEY`)에 있고 채팅 경로는 그 키를 읽지 않는다 — 그래서
// "issuer 를 안 싣는다" 가 우리가 매번 지켜야 하는 규율이 아니라 **구조**다.
// rehearsal-session.smoke.mjs 가 그 구조를 세어서 고정한다.

import * as vscode from "vscode";
import type { StartPage } from "./startPage";
import { ISSUER_TOKEN_KEY } from "./mintStudentTokenHelpers.ts";
import { redeemRehearsalTicket } from "./rehearsalEntryHelpers.ts";
import {
  IDLE,
  abort,
  activate,
  begin,
  finish,
  isRehearsing,
  rehearsalLabel,
  requestRehearsalTicket,
  settled,
  type LessonRef,
  type RehearsalState,
} from "./rehearsalSessionHelpers.ts";

export const REHEARSING_CONTEXT_KEY = "hypeproof-chat.rehearsing";

export interface RehearsalDeps {
  context: vscode.ExtensionContext;
  startPage: StartPage;
  proxyUrl: () => string;
  /** 현재 참여 자격. 돌아갈 자리를 들어가기 전에 잡아 둔다. */
  currentToken: () => Thenable<string | undefined>;
  /** 화면 부제를 다시 그린다 (Chalk 면). */
  onStateChange?: (state: RehearsalState) => void;
}

export interface RehearsalController {
  state: () => RehearsalState;
  start: (ref?: LessonRef) => Promise<void>;
  end: () => Promise<void>;
}

export function registerRehearsalSession(deps: RehearsalDeps): RehearsalController {
  const { context } = deps;
  let state: RehearsalState = IDLE;

  const publish = async () => {
    await vscode.commands.executeCommand("setContext", REHEARSING_CONTEXT_KEY, isRehearsing(state));
    deps.onStateChange?.(state);
  };

  /**
   * 수업 좌표를 묻는다. 저작 화면이 아직 좌표를 넘겨주지 않으므로 지금은 강사가
   * 입력한다 — 저작 쪽이 붙으면 `ref` 인자로 들어오고 이 분기는 안 탄다.
   */
  const askRef = async (): Promise<LessonRef | undefined> => {
    const cohort = await vscode.window.showInputBox({
      title: "리허설할 수업 — cohort id", ignoreFocusOut: true,
      prompt: "내 issuer 토큰이 발급 권한을 가진 cohort",
    });
    if (!cohort?.trim()) return undefined;
    const course = await vscode.window.showInputBox({
      title: "course id", ignoreFocusOut: true,
    });
    if (!course?.trim()) return undefined;
    const version = await vscode.window.showInputBox({
      title: "확정된 버전", ignoreFocusOut: true,
      prompt: "예: m2026.09.21-1 — 리허설은 고정된 버전에 대해서만 돈다 (VER-02)",
    });
    if (!version?.trim()) return undefined;
    return { cohort: cohort.trim(), course: course.trim(), version: version.trim() };
  };

  const start = async (given?: LessonRef): Promise<void> => {
    if (isRehearsing(state)) {
      vscode.window.showInformationMessage("이미 리허설 중입니다. 먼저 리허설을 끝내 주세요.");
      return;
    }
    const issuerToken = await context.secrets.get(ISSUER_TOKEN_KEY);
    if (!issuerToken) {
      vscode.window.showWarningMessage(
        "강사 issuer 토큰이 없습니다. '학생 토큰 발급'을 한 번 실행해 토큰을 저장한 뒤 다시 시도해 주세요.",
      );
      return;
    }
    const ref = given ?? (await askRef());
    if (!ref) return;

    // 돌아갈 자리를 **들어가기 전에** 잡는다. 교환이 실패해도 잃지 않는다.
    const previous = { token: await deps.currentToken() };
    state = begin(ref, previous);
    await publish();

    const proxyUrl = deps.proxyUrl();
    const ticket = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "리허설 교환권을 받는 중…" },
      () => requestRehearsalTicket({ proxyUrl, issuerToken, ref }),
    );
    if (!ticket.ok) {
      state = abort(state);
      state = settled();
      await publish();
      vscode.window.showWarningMessage(ticket.failure.friendly);
      return;
    }

    // 교환에는 **인증 헤더가 없다.** 교환권 자체가 자격증명이다 — 여기에 issuer 를
    // 실으면 ARC-02 가 막으려던 것이 되살아난다. 서버도 읽지 않는다.
    const redeemed = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "학생 조건으로 전환하는 중…" },
      () => redeemRehearsalTicket({ proxyUrl, ticket: ticket.result.ticket }),
    );
    if (!redeemed.ok) {
      state = abort(state);
      state = settled();
      await publish();
      vscode.window.showWarningMessage(redeemed.failure.friendly);
      return;
    }

    state = activate(state, redeemed.token);
    await publish();
    // 학생이 참여 코드를 넣는 것과 **같은 경로**로 들어간다.
    await deps.startPage.enterWithToken(redeemed.token);
    vscode.window.showInformationMessage(
      `학생 조건으로 리허설을 시작했습니다 — ${ref.course} ${ref.version}. 끝나면 '리허설 끝내기'를 누르세요.`,
    );
  };

  const end = async (): Promise<void> => {
    if (!isRehearsing(state)) return;
    const back = finish(state);
    state = back;
    await publish();
    const previous = back.phase === "returning" ? back.previous.token : undefined;
    if (previous) {
      // 원래 붙어 있던 활동으로 되돌린다. 좌석은 여기서 버려진다.
      await deps.startPage.enterWithToken(previous);
    } else {
      // 붙어 있던 곳이 없었다 — 없던 상태가 원래 상태다. 좌석만 끊는다.
      await vscode.commands.executeCommand("hypeproof-chat.start");
    }
    state = settled();
    await publish();
    vscode.window.showInformationMessage("리허설을 끝내고 강사 자리로 돌아왔습니다.");
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("hypeproof-chat.chalk.startRehearsal", (ref?: LessonRef) =>
      start(ref),
    ),
    vscode.commands.registerCommand("hypeproof-chat.chalk.endRehearsal", () => end()),
  );
  void publish();

  return { state: () => state, start, end };
}

export { rehearsalLabel };
