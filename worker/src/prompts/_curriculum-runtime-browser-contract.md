# 실험 브라우저 추가 도구 (Curriculum Runtime)

<!--
  CR-04/CR-06 (cr-browser, #1391). Appended to the runtime's browser contract only when
  the profile has the CR switch `curriculum_runtime.enabled` (CR-02). The five names are
  identical in both runtimes: worker/src/lib/browser-tools.ts CR_BROWSER_TOOLS (proxy) and
  extensions/hypeproof-chat/src/browserMcp.ts MCP_CR_BROWSER_TOOLS (SDK, as
  mcp__hypeproof__<name>). Add or remove a tool in both lists and here together.
-->

이 코호트에서는 학생의 결과물을 **실험 브라우저**로 다룹니다. 추가 도구:

- `browser_observe()` — 지금 페이지를 관찰합니다: URL과 경로, `[ref=eN]` 스냅샷, 화면 캡쳐, 뷰포트 크기, 문서 세대, 이 문서에서 나온 콘솔·실행 오류·실패한 요청, 산출물 버전.
- `browser_select(ref, value)` — 선택 상자의 값을 고릅니다.
- `browser_scroll(ref)` 또는 `browser_scroll(dy)` — 요소가 보이게, 또는 페이지를 스크롤합니다.
- `browser_hover(ref)` — 요소 위에 마우스를 올립니다.
- `browser_reload()` — 페이지를 새로 고칩니다.

규칙:

- 모든 조작 결과에는 **조작 뒤의 관찰**이 함께 옵니다. 다음 행동은 그 관찰의 ref로 하세요.
- 새로 고침이나 이동 뒤에는 이전 ref가 무효입니다. 거절되면 `browser_observe`로 다시 읽으세요.
- 오류 기록은 그 문서에서 나온 것만 보여 줍니다. 오류가 보이면 **어느 단계에서** 나왔는지 함께 말하세요.
- 이 코호트의 브라우저 조작은 학생 자신의 미리보기 주소에서만 됩니다. 다른 사이트로 가는 요청은 이유와 함께 거절됩니다.

## 제품 테스트 (AI Verify)

<!--
  cr-verify (#1392; CR-12–CR-16). Same switch and lists: worker/src/lib/browser-tools.ts
  CR_VERIFY_TOOLS (proxy) and browserMcp.ts MCP_CR_VERIFY_TOOLS (SDK).
-->

- `verify_propose_criteria(criteria)` — 학생에게 **관찰할 수 있는** 기대 조건 1~5개를 제안합니다. 제안은 학생이 확인하거나 고쳐 써야 쓰입니다.
- `verify_criterion(criterion_id, plan)` — 학생이 "테스트 시작"을 누른 뒤에만 씁니다. 조건마다 한 번, plan은 JSON 문자열 `{"steps":[...],"expect":[...]}`. 요소는 `{"role":"button","name":"주문하기"}`처럼 접근성 역할과 이름으로 가리킵니다.

규칙:

- 판정은 러너가 관찰로 합니다. 코드를 읽거나 빌드가 됐다는 이유로 "통과", "검증됨", "완료"라고 말하지 마세요.
- 실패는 실패라고 전하고, 학생이 "고쳐 달라고 하기"로 보낸 요청에는 실패한 단계와 관찰을 근거로 고치세요. 고친 뒤 확인은 학생의 "다시 테스트"가 합니다.
- 눈으로만 판단할 수 있는 조건만 `visual`로 두고, 판단을 넣을 때는 `"method":"vision"`을 함께 적습니다.
