// In-Studio "Mint Student Token" command (#66).
//
// Lets a 강사 mint a student/participant token from inside HypeProof Studio
// without leaving for the /issuer web UI. Wraps POST /admin/tokens/issue on
// the worker (same endpoint /issuer browser flow uses — PR #61).
//
// Pure helpers (validation, error mapping, issuer payload decoding) live in
// mintStudentTokenHelpers.ts so they unit-test under plain Node.

import * as vscode from "vscode";
import {
  adminBaseFor,
  mapMintError,
  validateInputs,
  issuerCohorts,
  issuerProfilesFor,
  ISSUER_TOKEN_KEY,
  type MintResponse,
} from "./mintStudentTokenHelpers";

export { ISSUER_TOKEN_KEY } from "./mintStudentTokenHelpers";

export interface MintCommandDeps {
  context: vscode.ExtensionContext;
  /** Worker /v1 base URL from configuration (proxyUrl). Mint endpoint lives
   *  at <origin>/admin/tokens/issue. */
  proxyUrl: string;
  /** Optional defaults the panel knows (profile from /v1/profile). Cohort and
   *  profile are read off the issuer token's scopes first; this profile is only
   *  a fallback hint for tokens whose scopes could not be decoded. */
  defaults?: { profile?: string };
}

/**
 * Run the mint command. Interactive via vscode.window prompts. Returns the
 * new student token on success, or undefined if the user cancelled or the
 * server rejected (errors are surfaced via showWarning).
 */
export async function runMintStudentToken(deps: MintCommandDeps): Promise<MintResponse | undefined> {
  const { context, proxyUrl, defaults } = deps;

  // 1. Issuer token — SecretStorage; prompt once if missing.
  let issuerToken = await context.secrets.get(ISSUER_TOKEN_KEY);
  if (!issuerToken) {
    const pasted = await vscode.window.showInputBox({
      title: "강사 issuer 토큰을 한 번 붙여넣어 주세요",
      prompt: "다음 발급부터는 자동으로 사용됩니다 (이 Studio 안에서만 저장)",
      password: true,
      ignoreFocusOut: true,
      placeHolder: "eyJjIjoi… 로 시작하는 issuer 토큰",
    });
    if (pasted === undefined || pasted.trim() === "") return undefined;
    issuerToken = pasted.trim();
    await context.secrets.store(ISSUER_TOKEN_KEY, issuerToken);
  }

  // 2. Cohort — read off the issuer token's own scopes (#347).
  //    One scope → prefill it. Several → make the 강사 pick; guessing one would
  //    mint into the wrong cohort and only fail later, at the student's first
  //    chat. Unreadable → empty box, never a hardcoded guess.
  const cohorts = issuerCohorts(issuerToken);
  const c =
    cohorts.length > 1
      ? await vscode.window.showQuickPick(cohorts, {
          title: "Cohort id — 내 issuer 토큰으로 발급 가능한 cohort",
          ignoreFocusOut: true,
        })
      : await vscode.window.showInputBox({
          title: "Cohort id",
          value: cohorts[0] ?? "",
          prompt:
            cohorts.length === 1
              ? "issuer 토큰 scope에서 가져왔어요"
              : "issuer 토큰에서 cohort를 읽지 못했어요 — 직접 입력하세요 (예: boah-dental-2026-a)",
          ignoreFocusOut: true,
        });
  if (c === undefined || c.trim() === "") return undefined;
  const cohort = c.trim();

  // 3. Profile — scoped to the cohort just chosen; /v1/profile default is only
  //    a hint for tokens whose scopes we could not read.
  const scopedProfiles = issuerProfilesFor(issuerToken, cohort);
  const p =
    scopedProfiles.length > 1
      ? await vscode.window.showQuickPick(scopedProfiles, {
          title: `Profile id — ${cohort}`,
          ignoreFocusOut: true,
        })
      : await vscode.window.showInputBox({
          title: "Profile id",
          value: scopedProfiles[0] ?? defaults?.profile ?? "",
          prompt:
            scopedProfiles.length === 1
              ? "issuer 토큰 scope에서 가져왔어요"
              : "예: boah-dental-teaser-2026-s1",
          ignoreFocusOut: true,
        });
  if (p === undefined || p.trim() === "") return undefined;
  const profile = p.trim();

  // 4. Student user id.
  const u = await vscode.window.showInputBox({
    title: "학생 user id",
    placeHolder: "예: student-01, hygienist-park, …",
    prompt: "영문/숫자/'._-' 만 허용",
    ignoreFocusOut: true,
  });
  if (u === undefined || u.trim() === "") return undefined;

  // 5. Hours (default 2).
  const hoursStr = await vscode.window.showInputBox({
    title: "유효 시간 (시간 단위)",
    value: "2",
    prompt: "1..1440. 단발 티저는 2시간 정도 권장.",
    ignoreFocusOut: true,
    validateInput: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 1440) return "1..1440 사이 정수";
      return null;
    },
  });
  if (hoursStr === undefined) return undefined;
  const hours = Number(hoursStr);

  // 6. Composite validate.
  const v = validateInputs(u.trim(), cohort, profile, hours);
  if (!v.ok) {
    vscode.window.showWarningMessage(`발급 불가: ${v.reason}`);
    return undefined;
  }

  // 7. POST <admin-base>/admin/tokens/issue.
  const url = adminBaseFor(proxyUrl) + "/admin/tokens/issue";
  let body: any;
  let status = 0;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issuerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ u: u.trim(), c: cohort, p: profile, hours }),
    });
    status = res.status;
    body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const friendly = mapMintError(body?.error ?? `HTTP ${status}`);
      // Auth fail → forget the stored issuer; likely stale.
      if (status === 401 || status === 403) {
        await context.secrets.delete(ISSUER_TOKEN_KEY);
      }
      vscode.window.showWarningMessage(`토큰 발급 실패: ${friendly}`);
      return undefined;
    }
  } catch (err) {
    vscode.window.showWarningMessage(
      `토큰 발급 실패: 네트워크 오류 — ${(err as Error).message}`,
    );
    return undefined;
  }

  const result: MintResponse = { token: body.token, jti: body.jti, exp: body.exp };

  // 8. Copy to clipboard + show metadata.
  await vscode.env.clipboard.writeText(result.token);
  const expISO = new Date(result.exp * 1000).toLocaleString();
  vscode.window
    .showInformationMessage(
      `✓ ${u.trim()}@${cohort} 학생 토큰 발급 — 클립보드에 복사됨 (만료: ${expISO})`,
      "다시 복사",
      "issuer 토큰 지우기",
    )
    .then(async (choice) => {
      if (choice === "다시 복사") {
        await vscode.env.clipboard.writeText(result.token);
      } else if (choice === "issuer 토큰 지우기") {
        await context.secrets.delete(ISSUER_TOKEN_KEY);
        vscode.window.showInformationMessage(
          "issuer 토큰이 지워졌어요. 다음 발급 시 다시 물어봅니다.",
        );
      }
    });
  return result;
}
