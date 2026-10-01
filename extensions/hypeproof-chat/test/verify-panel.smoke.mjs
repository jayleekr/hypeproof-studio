// CR-T76 UI half and the "내 제품 테스트" panel (cr-verify #1392). Renders the real
// VerifyPanel (test/sx-render.mjs) from a VerifyView the session computed over a real
// recorder, so what is drawn is what the host decided, never a value the panel derives.
//
// Run: node --experimental-strip-types test/verify-panel.smoke.mjs

import assert from "node:assert/strict";
import { rendererStatus, renderComponent, visibleText } from "./sx-render.mjs";

const status = rendererStatus();
if (!status.available) {
  console.log(`ok verify panel SKIP — ${status.detail}`);
  process.exit(0);
}

const V0 = `sha256:${"a".repeat(64)}`;
const V1 = `sha256:${"b".repeat(64)}`;
const crit = (id, text, status, extra = {}) => ({ id, text, status, method: "dom", reproducible: status !== "non_reproducible", steps: [{ index: 0, action: "navigate", ok: true, message: "이동 완료" }], cites: [{ step: 0, kind: "snapshot", detail: "heading: 주문이 완료되었어요" }], expectations: [], errors: [], result_ref: `r-${id}`, test_ref: `t-${id}`, test_kind: "test_observed", ...extra });
const report = (version, criteria) => ({ format: "hps-verification/1", run_id: "run-1", artifact_version_id: version, tested_at: new Date(0).toISOString(), viewport: { width: 800, height: 600 }, criteria, runtime_errors: [], network_errors: [], screenshots: [], steps: [] });
const view = (over = {}) => ({ available: true, reason: null, version: V0, verification: { state: "not_verified", open: [] }, report: null, run: null, proposals: [], running: false, notice: null, ...over });
const props = (v, extra = {}) => ({ view: v, error: null, busy: false, onStart() {}, onRetest() {}, onFix() {}, onClose() {}, ...extra });
const render = async (v, extra) => {
  const html = await renderComponent("VerifyPanel", props(v, extra));
  return { html, text: visibleText(html) };
};
let passed = 0;
const ok = (n) => { passed++; console.log(`✓ ${n}`); };

{
  const all = report(V0, [crit("c1", "음료 고르기가 보인다", "pass"), crit("c2", "완료 화면이 보인다", "pass"), crit("c3", "오류가 없다", "pass")]);
  const { html, text } = await render(view({ verification: { state: "verified", run_id: "run-1", open: [] }, report: all }));
  assert.match(html, /data-testid="verify-status" data-state="verified"/);
  assert.match(text, /검증됨 · 이 버전에서 기대 조건을 모두 통과했어요/);
  assert.match(text, /이 버전의 테스트 결과/);
  assert.equal((html.match(/data-status="pass"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /verify-fix"/, "nothing to fix");
  ok("CR-T76 UI positive: a version with a three-pass report bound to it shows 검증됨 with each result");
}
{
  const failed = report(V0, [crit("c1", "음료 고르기가 보인다", "pass"), crit("c2", "완료 화면이 보인다", "fail", { reason: undefined })]);
  const { html, text } = await render(view({ verification: { state: "failed", run_id: "run-1", open: [{ id: "c2", text: "완료 화면이 보인다", status: "fail" }] }, report: failed }));
  assert.match(html, /data-state="failed"/);
  assert.doesNotMatch(text, /검증됨/);
  assert.match(text, /실패 완료 화면이 보인다/);
  assert.equal((html.match(/data-testid="verify-fix"/g) ?? []).length, 1, "a fix request control on the failed criterion only");
  ok("CR-T76 UI positive: a report with a fail shows the fail and offers a fix request for that criterion");
}
{
  for (const [label, v] of [
    ["no report", view()],
    ["a report bound to another version", view({ version: V1, verification: { state: "needs_recheck", open: [], previous: { run_id: "run-1", artifact_version_id: V0 } }, report: report(V0, [crit("c1", "a", "pass")]) })],
  ]) {
    const { html, text } = await render(v);
    assert.doesNotMatch(text, /검증됨/, label);
    assert.doesNotMatch(html, /data-state="verified"/, label);
    if (v.report) {
      assert.match(text, /이전 버전의 테스트 결과/, `${label}: the earlier result stays, labelled as the earlier version's`);
      assert.match(text, /파일이 바뀌었어요/);
    }
  }
  ok("CR-T76 UI negative: no report, or a report of another version, never shows 검증됨 (the earlier result is kept and labelled)");
}
{
  const { html, text } = await render(view({ running: true }));
  assert.match(html, /data-testid="verify-running"/);
  assert.match(text, /테스트 중 — 실험 브라우저가 화면을 움직이고 있어요/);
  assert.match(html, /data-testid="verify-start"[^>]*disabled/, "no second start while one runs");
  const idle = await render(view());
  assert.doesNotMatch(idle.html, /verify-running/);
  ok("CR-T63 UI: the panel shows the run while it acts on the page, and not after");
}
{
  const { html, text } = await render(view({ proposals: [{ id: "p1", text: "주문 시작이 보인다" }] }));
  assert.match(html, /data-testid="verify-proposal"/);
  assert.match(text, /코치가 제안한 조건 — 확인해야 테스트에 쓰여요/);
  ok("CR-T12 UI: coach proposals are offered as drafts to confirm, not as criteria");
}
console.log(`\n${passed} verify panel checks passed`);
