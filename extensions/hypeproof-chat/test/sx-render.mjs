// 렌더 계측기 — 실제 webview 컴포넌트를 정적 HTML 로 렌더해서 **렌더된 텍스트**를 돌려준다.
//
// 왜 소스를 읽지 않고 렌더하나 (.claude/rules/verification.md 규칙 1):
//   "화면에 금지 문자열이 없다" 는 주장을 소스 grep 으로 판정하면, 조건부로만
//   렌더되는 분기·템플릿 조립·상수 참조를 전부 놓친다. 판정 기준을 세우기 전에
//   **판정 대상(렌더 결과)** 을 연다. docs/plan/ux-dag.yaml P0-B 의 수용 기준도
//   "The instrument reads real component render output, not a copy of the strings".
//
// 어떻게:
//   test/clear-history.smoke.mjs · test/start-page.smoke.mjs 의 관용을 그대로 쓴다 —
//   esbuild 로 한 번들을 만들고 vm.runInNewContext 로 돌린다. 다른 점은 resolveDir 이
//   webview-ui 라는 것뿐이다. react / react-dom / react/jsx-runtime 이 거기 있기 때문이다.
//
// 알려진 한계 (보고서에도 남김):
//   CI 의 `npm ci --omit=optional` 은 **확장 의존성만** 설치한다
//   (.github/workflows/pr-ci.yml extension-test 잡). webview-ui/node_modules 는 없다.
//   그래서 react 가 없으면 rendererStatus() 가 reason:"webview-deps-missing" 을 돌려주고
//   호출자가 그 사실을 **드러내고** 건너뛴다. 조용히 통과시키지 않는다. 순수 텍스트
//   대조군과 빈 영역 가드(auditRegionText 의 empty_region)는 CI 에서도 그대로 돈다.

import vm from "node:vm";
import { build } from "esbuild";
import { createRequire } from "node:module";

const here = new URL("./", import.meta.url);
const webviewDir = new URL("../webview-ui/", here);
const nodeRequire = createRequire(import.meta.url);
const webviewRequire = createRequire(new URL("package.json", webviewDir));

/** 렌더할 수 있는 실제 컴포넌트. 경로는 webview-ui 기준. */
export const COMPONENTS = {
  // 호스트 브리지 없이 그대로 렌더된다: useEffect 는 SSR 에서 돌지 않고,
  // src/vscode.ts 는 모듈 최상위에서 `window.acquireVsCodeApi` 를 보기만 한다
  // (window 스텁을 주면 undefined 로 떨어진다).
  NativeObservationPanel: { from: "./src/NativeObservationPanel.tsx", exportName: "NativeObservationPanel" },
  // 영역 A(SX-01~05). 호스트 브리지 없이 렌더된다 — 콜백은 props 로 주입받고
  // 모듈 최상위에서 vscode API 를 만지지 않는다.
  MissionHeader: { from: "./src/MissionHeader.tsx", exportName: "MissionHeader" },
};

/**
 * react / react-dom 이 webview-ui 에 설치돼 있는지. 추측하지 않고 resolve 해 본다.
 *
 * `resolve` 를 주입할 수 있게 열어 둔 이유: CI 경로(react 없는 루트)를 **이 함수
 * 자체로** 재현해 보기 위해서다. 대조군이 건너뛴다고 말할 때 정말 그 이유로
 * 건너뛰는지 확인하지 않으면, 건너뛰기가 조용한 통과가 된다(규칙 4).
 */
export function rendererStatus(resolve = (id) => webviewRequire.resolve(id)) {
  for (const id of ["react", "react/jsx-runtime", "react-dom/server"]) {
    try {
      resolve(id);
    } catch (error) {
      return {
        available: false,
        reason: "webview-deps-missing",
        detail: `${id} 를 webview-ui 에서 resolve 하지 못했다: ${error.message}`,
      };
    }
  }
  return { available: true, reason: null, detail: `webview-ui/node_modules 에서 react 를 찾았다` };
}

let compiled = null;

async function loadBundle() {
  if (compiled) return compiled;
  const status = rendererStatus();
  if (!status.available) throw new Error(`렌더 계측기를 쓸 수 없다 — ${status.detail}`);

  const entry = [
    `import { createElement } from "react";`,
    `import { renderToStaticMarkup } from "react-dom/server";`,
    ...Object.entries(COMPONENTS).map(
      ([name, c], i) => `import { ${c.exportName} as C${i} } from ${JSON.stringify(c.from)}; /* ${name} */`,
    ),
    `const registry = {${Object.keys(COMPONENTS).map((name, i) => `${JSON.stringify(name)}: C${i}`).join(",")}};`,
    `export function render(name, props) {`,
    `  const Component = registry[name];`,
    `  if (!Component) throw new Error("unknown component: " + name);`,
    `  return renderToStaticMarkup(createElement(Component, props || {}));`,
    `}`,
    `export const names = Object.keys(registry);`,
  ].join("\n");

  const bundle = await build({
    stdin: { contents: entry, resolveDir: webviewDir.pathname, loader: "tsx", sourcefile: "sx-render-entry.tsx" },
    bundle: true,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    write: false,
    logLevel: "silent",
  });

  // webview 코드가 모듈 최상위에서 만지는 것만 준다. 호스트 브리지는 주지 않는다 —
  // 브리지 없이도 렌더되는지가 이 계측기가 확인하려는 사실이다.
  const windowStub = { addEventListener() {}, removeEventListener() {}, postMessage() {} };
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    require: nodeRequire,
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    URL,
    window: windowStub,
    self: windowStub,
  };
  vm.runInNewContext(bundle.outputFiles[0].text, context);
  compiled = module.exports;
  return compiled;
}

/** 실제 컴포넌트를 정적 HTML 로 렌더한다. */
export async function renderComponent(name, props = {}) {
  const api = await loadBundle();
  return api.render(name, props);
}

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "button", "dd", "details", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hr", "img", "input", "label", "legend", "li", "main", "nav", "ol", "option", "p", "pre", "section",
  "select", "summary", "table", "tbody", "td", "textarea", "tfoot", "th", "thead", "tr", "ul",
]);

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·",
};

function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
  });
}

/**
 * 마크업에서 **보이는 텍스트**만 뽑는다. 블록 요소 경계는 줄바꿈이 된다 —
 * 문장 단위 부정문 면제(sx-audit.mjs)가 옆 요소의 문장과 섞이지 않게 하려는 것이다.
 */
export function visibleText(html) {
  const stripped = String(html ?? "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (_whole, tag) =>
      BLOCK_TAGS.has(tag.toLowerCase()) ? "\n" : "",
    );
  return decodeEntities(stripped)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** 렌더 + 텍스트 추출을 한 번에. */
export async function renderVisibleText(name, props = {}) {
  return visibleText(await renderComponent(name, props));
}
