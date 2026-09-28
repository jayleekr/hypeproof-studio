// #751 U1b — the learner marks one exact version of their page (workspace index.html) as their class result, or withdraws that
// mark. Only marked versions travel in an "approved artifacts" collection; this flow itself sends nothing and never approves by
// itself. Kept free of the VS Code API so the ownership rules can run against a real SessionSpool in tests.
//
// What the learner is asked about is the version read BEFORE the question opens, and that is exactly what gets recorded:
//  - if another learner signs in, the session changes, or the classroom connection changes while the question is open, nothing
//    is written (the answer belonged to the record the question was asked for);
//  - if the file changes while the question is open, the recorded version is still the one shown, and the learner is told.
import { createHash } from "crypto";
import { SPOOL_MAX_ARTIFACT_CHARS, type SpoolOwner } from "./sessionSpool.ts";

export interface ApprovalPage { sha256: string; kb: number; cut: boolean }
export interface ApprovalDeps {
  owner(): Promise<SpoolOwner>;
  /** The classroom connection the question is asked under ('' = none). A different value afterwards means it changed. */
  classroom(): string;
  readPage(): Promise<string | null>;
  /** true = approve, false = withdraw the approval, undefined = closed without choosing. */
  ask(page: ApprovalPage): Promise<boolean | undefined>;
  record(owner: SpoolOwner, e: { content: string; path: string; approved: boolean }): Promise<boolean>;
}
export type ApprovalOutcome =
  | { status: "no_learner" } | { status: "no_page" } | { status: "cancelled"; page: ApprovalPage }
  | { status: "owner_changed"; page: ApprovalPage }
  | { status: "recorded"; approved: boolean; page: ApprovalPage; changed_since: boolean };

const isPage = (t: string | null): t is string => typeof t === "string" && (/<html[\s>]/i.test(t) || /<!doctype html/i.test(t));
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
export function describePage(content: string): ApprovalPage {
  return { sha256: sha(content), kb: Math.max(1, Math.round(Buffer.byteLength(content, "utf8") / 1024)), cut: content.length > SPOOL_MAX_ARTIFACT_CHARS };
}

export async function approveArtifact(d: ApprovalDeps): Promise<ApprovalOutcome> {
  const owner = await d.owner(), classroom = d.classroom();
  if (!owner.identity) return { status: "no_learner" };
  const content = await d.readPage();
  if (!isPage(content)) return { status: "no_page" };
  const page = describePage(content), approved = await d.ask(page);
  if (approved === undefined) return { status: "cancelled", page };
  if (d.classroom() !== classroom || !(await d.record(owner, { content, path: "index.html", approved }))) return { status: "owner_changed", page };
  const now = await d.readPage();
  return { status: "recorded", approved, page, changed_since: !isPage(now) || sha(now) !== page.sha256 };
}

const mark = (p: ApprovalPage) => `지문 ${p.sha256.slice(0, 8)}`;
/** The two choices, each naming the exact version (fingerprint) and, for a page over the save limit, that only its start is kept. */
export function approvalChoices(p: ApprovalPage): Array<{ label: string; detail: string; approved: boolean }> {
  const cut = p.cut ? " · 저장 한도보다 커서 앞부분만 보관됩니다" : "";
  return [
    { label: "이 결과물을 수업 결과물로 승인", detail: `index.html · ${p.kb}KB · ${mark(p)}${cut}`, approved: true },
    { label: "이 결과물의 승인 취소", detail: `index.html · ${mark(p)}`, approved: false },
  ];
}
export const APPROVAL_PLACEHOLDER = "승인한 판만 ‘학생이 승인한 결과물’ 회수에 들어갑니다. 지금 바로 보내지는 않으며, 수업 기록 보내기에 동의한 경우에만 보냅니다.";
/** What the learner is told afterwards. Null = nothing to say (closed without choosing). */
export function approvalMessage(o: ApprovalOutcome): string | null {
  switch (o.status) {
    case "no_learner": return "누구의 결과물인지 확인되지 않아 표시하지 않았습니다. 학생 코드로 시작한 뒤 다시 해 주세요.";
    case "no_page": return "작업 폴더에 결과물(index.html)이 없습니다. 결과물을 만든 뒤 다시 해 주세요.";
    case "cancelled": return null;
    case "owner_changed": return "고르는 동안 학생 또는 수업 연결이 바뀌어 아무것도 기록하지 않았습니다. 다시 열어 확인해 주세요.";
    case "recorded": {
      const head = o.approved ? `이 판(${mark(o.page)})을 수업 결과물로 승인했습니다.` : `이 판(${mark(o.page)})의 승인을 취소했습니다.`;
      const cut = o.approved && o.page.cut ? " 이 판은 저장 한도보다 커서 앞부분만 보관되며, 강사 화면에는 ‘잘린 결과물’로 표시됩니다." : "";
      const after = o.changed_since ? " 고르는 사이에 파일이 바뀌었습니다 — 기록한 것은 창을 열 때의 판이며, 지금 파일은 따로 다시 승인해야 합니다." : o.approved ? " 나중에 고치면 새 판은 다시 승인해야 합니다." : "";
      return head + cut + after;
    }
  }
}
