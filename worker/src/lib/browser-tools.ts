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
