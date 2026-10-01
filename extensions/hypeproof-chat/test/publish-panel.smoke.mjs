// The "사용자 테스트용으로 공개" panel (cr-publish #1393), rendered for real (test/sx-render.mjs)
// from PublishView values the host computes. CR-T17/CR-T76 UI half: the publish action
// shows "검증됨" only for the state the host read for this exact version; CR-19: no expiry is
// preselected; CR-18: a live link shows its URL and QR, a revoked one neither; CR-73: per
// channel counts are labelled as opens, not demand.
//
// Run: node --experimental-strip-types test/publish-panel.smoke.mjs

import assert from "node:assert/strict";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";

const status = rendererStatus();
if (!status.available) {
  console.log(`ok publish panel SKIP — ${status.detail}`);
  process.exit(0);
}
const V0 = `sha256:${"a".repeat(64)}`;
const V1 = `sha256:${"b".repeat(64)}`;
const URL0 = "http://prj-0123456789abcdef.test.invalid/l/4fUq8IIB84B-cny9Iy60WQ/";
const view = (over = {}) => ({
  available: true,
  reason: null,
  project: { id: "prj-0123456789abcdef", title: "키오스크" },
  version: { id: V0, files: [{ path: "index.html", bytes: 10 }, { path: "app.js", bytes: 5 }], manifest_added: [], refusal: null, refusal_lines: [] },
  verification: { state: "not_verified", open: [] },
  hypotheses: [],
  experiments: [],
  timing: null,
  notice: null,
  ...over,
});
const props = (v, extra = {}) => ({ view: v, error: null, errorLines: [], shareUrl: null, busy: false, onManifest() {}, onSubmit() {}, onLink() {}, onRevoke() {}, onClose() {}, ...extra });
const render = async (v, extra) => {
  const html = await renderComponent("PublishPanel", props(v, extra));
  return { html, text: visibleText(html) };
};
let passed = 0;
const ok = (n) => { passed++; console.log(`✓ ${n}`); };

{
  const { html, text } = await render(view({ verification: { state: "verified", run_id: "run-1", open: [] } }));
  assert.match(html, /data-testid="publish-verified" data-state="verified"/);
  assert.match(text, /검증됨 · 이 버전은 기대 조건을 모두 통과했어요/);
  assert.match(text, /공개할 버전 aaaaaaaa · 파일 2개/);
  ok("CR-T17 UI positive: a version whose all-pass report the host read shows 검증됨 on the publish action");
}
for (const state of ["not_verified", "needs_recheck", "failed", "incomplete"]) {
  const { html, text } = await render(view({ verification: { state, open: [] } }));
  assert.match(html, new RegExp(`data-state="${state}"`));
  assert.doesNotMatch(text, /검증됨/, state);
  assert.match(text, /검증 안 됨/);
}
ok("CR-T17 UI negative: no report, another version's report, a fail or an incomplete report never shows 검증됨");
{
  const { html } = await render(view());
  assert.doesNotMatch(html, /type="radio"[^>]*checked/, "no expiry is preselected (CR-19: no default until Jay sets one)");
  assert.match(html, /data-testid="publish-submit"[^>]*disabled/, "the action waits for the student's choices");
  ok("CR-19: the link period has no default; the publish action waits for it");
}
{
  const { html, text } = await render(view({ version: { id: null, files: [], manifest_added: [], refusal: "app.js: 비밀값처럼 보이는 내용이 있어 공개하지 않았어요.", refusal_lines: ["app.js 2번째 줄 (openai_key)"] } }));
  assert.match(text, /app\.js 2번째 줄 \(openai_key\)/);
  assert.match(html, /data-testid="publish-refusal"/);
  ok("a refused set names the file and line");
}
{
  const exp = (links, sessions = null) => ({ id: "exp-1", week: 1, question: "도움 없이 주문할 수 있나?", method: "task_test", success_criteria: ["3/5"], hypothesis: "혼자 주문할 수 있다", product_version_id: V1, current_version: false, status: "running", links, sessions });
  const live = { id: "L1", channel: "학교 게시판", share_url: URL0, qr: "data:image/svg+xml;base64,AAAA", expires_at: Date.now() + 3600_000, state: "live" };
  const revoked = { id: "L2", channel: "1:1 메시지", share_url: URL0.replace("4fUq", "XXXX"), qr: null, expires_at: Date.now() + 3600_000, state: "revoked" };
  const { html, text } = await render(view({ experiments: [exp([live, revoked], { channels: { "학교 게시판": 2 }, unlabelled: 0, unknown: 1 })] }));
  assert.equal((html.match(/data-testid="publish-qr"/g) ?? []).length, 1, "the live link has a QR; the revoked one none");
  assert.equal((html.match(/data-testid="publish-revoke"/g) ?? []).length, 1);
  assert.match(text, new RegExp(URL0.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(text, /XXXX/, "a revoked link's URL is not offered");
  assert.match(text, /이전 버전 · 이 실험은 계속 이 버전을 보여 줘요/, "CR-22: the experiment says it stays on its version");
  assert.match(text, /링크를 연 횟수: 학교 게시판 2 · 채널 이름 없음 0 · 알 수 없음 1/);
  assert.match(text, /연 횟수예요\. 원한다는 뜻은 아니에요\./, "SX-58: a usage observation, never a demand claim");
  ok("CR-18/CR-19/CR-73: a live link shows URL and QR, a revoked one neither; opens are counted per channel and labelled as opens");
}
{
  const { text } = await render(view({ timing: { ms: 12_500, ok: false, cause: "upload 11900ms" } }));
  assert.match(text, /공개에 12\.5초 걸렸어요 \(목표 10초 · 원인 upload 11900ms\)/);
  const fast = await render(view({ timing: { ms: 3_000, ok: true, cause: null } }));
  assert.doesNotMatch(fast.text, /걸렸어요/);
  ok("CR-64: a miss is shown with its cause, a pass is not announced");
}
{
  const { text, html } = await render(view({ available: false, reason: "이 수업에서는 사용자 테스트 공개를 쓸 수 없어요." }));
  assert.match(text, /쓸 수 없어요/);
  assert.doesNotMatch(html, /publish-submit/);
  ok("unavailable: the reason, no action");
}
console.log(`\n${passed} publish panel checks passed`);
