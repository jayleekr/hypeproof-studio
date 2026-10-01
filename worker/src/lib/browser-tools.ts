// #278 Phase 3 — browser control tools for the coach's client-driven agentic
// loop. WORKER-DEFINED (not client-supplied) so schemas can't be tampered with
// and cache across the cohort. Injected into the Anthropic tools array only when
// profile.browser_control.enabled. The extension host executes each via CDP over
// the integrated browser and echoes back a tool_result turn.

export interface BrowserToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const BROWSER_TOOLS: BrowserToolDef[] = [
  {
    name: "browser_navigate",
    description:
      "브라우저를 주어진 URL로 이동한다(현재 탭). http/https/localhost/file 주소만 허용. 참고 사이트나 사용자가 만든 페이지를 열 때 사용.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "이동할 주소" } },
      required: ["url"],
    },
  },
  {
    name: "browser_read",
    description:
      "현재 페이지의 접근성/DOM 스냅샷을 텍스트로 읽는다. 상호작용 요소마다 [ref=eN] 라벨이 붙는다. browser_click/browser_type 전에 반드시 먼저 호출해 최신 ref를 얻는다(이동·클릭 후엔 ref가 무효화됨).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browser_screenshot",
    description: "현재 보이는 화면을 캡쳐한다(JPEG 이미지). 레이아웃·시각적 확인이 필요할 때만 사용.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "browser_read가 알려준 ref의 요소를 클릭한다.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string", description: "browser_read 스냅샷의 [ref=eN]" } },
      required: ["ref"],
    },
  },
  {
    name: "browser_type",
    description: "ref 입력 요소에 텍스트를 입력한다. submit이 true면 입력 후 Enter를 누른다.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "browser_read 스냅샷의 [ref=eN]" },
        text: { type: "string", description: "입력할 텍스트" },
        submit: { type: "boolean", description: "입력 후 Enter 여부(기본 false)" },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "browser_back",
    description: "브라우저 히스토리 뒤로 가기.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browser_forward",
    description: "브라우저 히스토리 앞으로 가기.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browser_dialog",
    description: "열린 자바스크립트 대화상자(alert/confirm/prompt)를 수락하거나 취소한다.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["accept", "dismiss"], description: "accept=확인, dismiss=취소" },
        promptText: { type: "string", description: "prompt 대화상자에 넣을 값(선택)" },
      },
      required: ["action"],
    },
  },
];

/**
 * Curriculum Runtime Experiment Browser tools (CR-04, CR-06; recon R1). Injected next
 * to BROWSER_TOOLS only when the profile has BOTH `browser_control.enabled` and the
 * CR switch `curriculum_runtime.enabled` (CR-02). The SDK coach exposes the same five
 * short names as `mcp__hypeproof__<name>` (browserMcp.ts `MCP_CR_BROWSER_TOOLS`), so
 * one contract (`_curriculum-runtime-browser-contract.md`) serves both runtimes.
 * With the switch on, every action also returns the resulting observation.
 */
export const CR_BROWSER_TOOLS: BrowserToolDef[] = [
  {
    name: "browser_observe",
    description:
      "현재 페이지를 관찰한다: URL·경로, [ref=eN] 스냅샷, 화면 캡쳐, 뷰포트, 문서 세대, 이 문서의 콘솔·오류·실패한 요청, 산출물 버전.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browser_select",
    description: "ref 선택 상자(select)의 값을 고른다. value는 option의 value 또는 보이는 글자.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "관찰 스냅샷의 [ref=eN]" },
        value: { type: "string", description: "고를 option의 value 또는 글자" },
      },
      required: ["ref", "value"],
    },
  },
  {
    name: "browser_scroll",
    description: "ref 요소가 보이도록 스크롤한다. ref 없이 dy(픽셀)만 주면 페이지를 그만큼 스크롤한다.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "관찰 스냅샷의 [ref=eN] (선택)" },
        dy: { type: "number", description: "ref가 없을 때 세로 스크롤 픽셀" },
      },
    },
  },
  {
    name: "browser_hover",
    description: "ref 요소 위에 마우스를 올린다.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string", description: "관찰 스냅샷의 [ref=eN]" } },
      required: ["ref"],
    },
  },
  {
    name: "browser_reload",
    description: "현재 페이지를 새로 고친다. 새 문서가 되므로 이전 ref는 모두 무효가 된다.",
    input_schema: { type: "object", properties: {} },
  },
];
