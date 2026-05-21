// Issue #64: in-Studio bug report. Collects a short description + auto-
// attached metadata (request_id, jti hash, profile, version, OS) and POSTs
// to the Worker's /v1/report endpoint. Discord-first triage on the receiving
// side — see worker/src/routes/report.ts.
//
// Public API:
//   runReportProblemCommand(deps): runs the QuickInput cascade and submits.
//
// Design notes:
//   - Uses VS Code's built-in QuickInput primitives instead of a webview
//     panel. Simpler, no new bridge messages, no DOM. The "modal" in the
//     spec is achieved by a 3-step QuickInput sequence:
//        1. describe what went wrong (multi-line allowed)
//        2. include recent turns? (QuickPick yes/no)
//        3. contact (optional input)
//     Then a Progress notification while submitting.
//   - jti is hashed locally via SubtleCrypto so we never send the full token,
//     never persist it, and the Discord card / D1 row only ever see 16 hex.
//   - Failure modes: network error / 4xx — surface a Warning toast with the
//     error reason. The whole point of this feature is that THIS path stays
//     working even when the chat path is broken, so it must never throw to
//     the user.

import * as vscode from "vscode";
import * as os from "os";
import { TOKEN_KEY } from "./extension";
import { ChatMessage } from "./protocol";
import {
  hashJti,
  extractJtiUnverified,
  sanitizeRecentTurns,
} from "./reportProblemHelpers";

export interface ReportProblemDeps {
  context: vscode.ExtensionContext;
  /**
   * Last response/error's request_id, if any. ChatPanelProvider stashes this
   * after every streamError/streamEnd so a report immediately after a failure
   * picks the right one up.
   */
  getLastRequestId: () => string | undefined;
  /**
   * Currently-resolved profile_id (from cached profile), if any.
   */
  getProfileId: () => string | undefined;
  /**
   * Most recent N chat turns (already in workspaceState). The caller pages
   * the array — we only ever take the tail.
   */
  getRecentTurns: () => ChatMessage[];
}

const REPORT_VERSION = "0.1.1"; // hypeproof-chat extension version (matches package.json)

interface SubmitResult {
  ok: true;
  reportId: string;
}

interface SubmitFail {
  ok: false;
  reason: string;
  httpStatus?: number;
}

async function submitReport(
  proxyBase: string,
  body: Record<string, unknown>,
  token: string | undefined,
): Promise<SubmitResult | SubmitFail> {
  const url = proxyBase.replace(/\/+$/, "") + "/report";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = "Bearer " + token;

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (err) {
    return { ok: false, reason: `네트워크 오류: ${(err as Error).message}` };
  }
  if (res.status === 429) {
    return { ok: false, reason: "신고가 너무 자주 들어오고 있어요. 잠시 후 다시 시도해주세요.", httpStatus: 429 };
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const json = (await res.json()) as { error?: { message?: string } | string };
      const msg = typeof json.error === "string" ? json.error : json.error?.message;
      if (msg) detail = msg;
    } catch { /* fallthrough */ }
    return { ok: false, reason: detail, httpStatus: res.status };
  }
  try {
    const j = (await res.json()) as { report_id?: string };
    if (!j.report_id) return { ok: false, reason: "서버 응답에 report_id가 없어요." };
    return { ok: true, reportId: j.report_id };
  } catch (err) {
    return { ok: false, reason: `응답 파싱 실패: ${(err as Error).message}` };
  }
}

/**
 * Build the metadata blob attached to every report. Each item is itemized
 * so the modal can show what's being sent and the user can mentally consent
 * (we don't make these opt-out per-field today — that's a follow-up if it
 * matters; today the only opt-in is recent_turns which is PII-bearing).
 */
function collectMetadata(deps: ReportProblemDeps, jtiHash?: string): Record<string, unknown> {
  return {
    studio_version: REPORT_VERSION,
    extension: "hypeproof-chat",
    os: `${os.platform()}-${os.release()}-${os.arch()}`,
    locale: vscode.env.language,
    vscode_version: vscode.version,
    profile_id: deps.getProfileId(),
    jti_hash: jtiHash,
    last_request_id: deps.getLastRequestId(),
    ts_client: new Date().toISOString(),
  };
}

export async function runReportProblemCommand(deps: ReportProblemDeps): Promise<void> {
  // Step 1: description.
  const description = await vscode.window.showInputBox({
    title: "문제 신고하기",
    prompt: "무엇이 안 되나요? (10자 이상)",
    placeHolder: "예: 토큰 붙여넣었는데 '틀리다'고 떠요. 다섯 번 다시 해봐도 같은 메시지.",
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v || v.trim().length < 10) return "10자 이상 적어주세요.";
      if (v.length > 5000) return "5000자 이하로 줄여주세요.";
      return null;
    },
  });
  if (description === undefined || description.trim().length === 0) return;

  // Step 2: include recent turns? (default: no)
  const includeChoice = await vscode.window.showQuickPick(
    [
      { label: "$(eye-closed) 최근 대화는 포함하지 않기", value: false, description: "기본값 — 메타데이터만 전송" },
      { label: "$(eye) 최근 3개 대화 포함", value: true, description: "개인정보가 포함될 수 있어요. 신고에 도움이 될 때만 선택" },
    ],
    {
      title: "최근 대화 첨부 여부",
      placeHolder: "신고에 최근 대화 3개를 함께 보낼까요?",
      ignoreFocusOut: true,
    },
  );
  if (includeChoice === undefined) return;
  const includeRecentTurns = includeChoice.value;

  // Step 3: contact (optional).
  const contact = await vscode.window.showInputBox({
    title: "연락처 (선택)",
    prompt: "Jay가 회신할 수 있는 연락처 (디스코드 ID, 이메일 등). 비워둬도 OK.",
    placeHolder: "tj.kr (선택)",
    ignoreFocusOut: true,
    validateInput: (v) => (v && v.length > 200 ? "200자 이하로 줄여주세요." : null),
  });
  // contact === undefined means user cancelled with Escape; treat as cancel.
  if (contact === undefined) return;

  // Submit with progress notification.
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "문제 신고 접수 중…", cancellable: false },
    async () => {
      const token = await deps.context.secrets.get(TOKEN_KEY);
      let jtiHash: string | undefined;
      if (token) {
        const jti = extractJtiUnverified(token);
        if (jti) jtiHash = await hashJti(jti);
      }

      const attachments = collectMetadata(deps, jtiHash);
      const recentTurns = includeRecentTurns ? sanitizeRecentTurns(deps.getRecentTurns()) : undefined;

      const body: Record<string, unknown> = {
        description: description.trim(),
        request_id: deps.getLastRequestId(),
        profile_id: deps.getProfileId(),
        contact: contact.trim() || undefined,
        include_recent_turns: includeRecentTurns,
        recent_turns: recentTurns,
        attachments,
      };

      const cfg = vscode.workspace.getConfiguration("hypeproofChat");
      const proxyUrl = cfg.get<string>("proxyUrl", "https://api.hypeproof-ai.xyz/v1");

      const result = await submitReport(proxyUrl, body, token);
      if (result.ok) {
        const msg = `신고 접수됐어요. ID: ${result.reportId}\nJay가 #hypeproof-studio 채널에서 확인하는 대로 회신드릴게요.`;
        vscode.window.showInformationMessage(msg);
      } else {
        vscode.window.showWarningMessage(`신고 전송 실패: ${result.reason}`);
      }
    },
  );
}

// Exposed for tests. Pure functions only — keep DOM/VS Code APIs out so
// these can run under node --experimental-strip-types.
export const __testing = {
  hashJti,
  extractJtiUnverified,
  sanitizeRecentTurns,
};
