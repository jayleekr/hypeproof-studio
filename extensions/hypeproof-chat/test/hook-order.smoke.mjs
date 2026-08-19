// REQ-F6 — 조기 return 이 훅들 사이에 끼면 안 된다.
//
// 왜 이 TC 가 있나
//   2026-08-10 실기기 세션에서 코치 작명 의식 도중 채팅 패널이 두 번 크래시했다
//   (React #300 · #310). 원인은 `ChatPanel` 의 작명 카드 조기 return 이 훅 3개
//   **위**에 있던 것:
//
//     작명 전 (needsNaming=true)  → return → 훅 N개
//     아이가 이름 저장 → coach.configured=true
//     작명 후 (needsNaming=false) → 통과   → 훅 N+3개   ← "Rendered more hooks"
//
//   작명 의식은 모든 학생이 반드시 통과하므로 정상 경로에서 100% 재현된다.
//   런타임 크래시라 타입체크·기존 스모크가 전부 초록인 채로 지나갔다.
//
// 이 TC 는 소스를 정적으로 읽어 컴포넌트별 "첫 조기 return 이후의 훅"을 센다.
// 앱을 띄우지 않으므로 밀리초에 끝나고 매 PR 마다 돈다.
//
// 대조군을 둘 다 둔다 (rules/verification.md §2):
//   음성 — 위반 사본은 반드시 잡혀야 한다. 통과하면 계측기가 고장난 것
//   양성 — 올바른 사본은 통과해야 한다. 너무 엄격하지 않은지

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const TARGET = join(here, "..", "webview-ui", "src", "ChatPanel.tsx");

const HOOK = /\buse(State|Effect|Memo|Callback|Ref|Reducer|LayoutEffect|Context)\s*\(/;
const COMPONENT = /^(?:export\s+)?function\s+([A-Z][A-Za-z0-9_]*)/;
const EARLY_RETURN = /^\s*(?:if\s*\(.*\)\s*)?return\b/;

/** 컴포넌트별로 (첫 조기 return 이후에 호출되는 훅) 을 찾는다. */
export function findHooksAfterEarlyReturn(source) {
  const lines = source.split("\n");
  const bounds = [];
  lines.forEach((l, i) => {
    const m = COMPONENT.exec(l);
    if (m) bounds.push({ line: i + 1, name: m[1] });
  });
  bounds.push({ line: lines.length + 1, name: "<EOF>" });

  const violations = [];
  for (let b = 0; b < bounds.length - 1; b++) {
    const { line: start, name } = bounds[b];
    const end = bounds[b + 1].line;

    let firstReturn = null;
    for (let ln = start + 1; ln < end; ln++) {
      const l = lines[ln - 1];
      if (!EARLY_RETURN.test(l)) continue;
      // 컴포넌트의 마지막 JSX return 도 매칭되지만, 그 뒤에는 훅이 없으므로
      // 위반으로 잡히지 않는다 — 별도 구분이 필요 없다.
      if (l.includes("return null") || l.includes("return <") || l.includes("return (")) {
        firstReturn = ln;
        break;
      }
    }
    if (firstReturn === null) continue;

    const late = [];
    for (let ln = firstReturn + 1; ln < end; ln++) {
      if (HOOK.test(lines[ln - 1])) late.push(ln);
    }
    if (late.length) violations.push({ component: name, firstReturn, hooks: late });
  }
  return violations;
}

let failed = 0;
const ok = (msg) => console.log(`  ok   ${msg}`);
const bad = (msg) => {
  console.log(`  FAIL ${msg}`);
  failed++;
};

console.log("=== 1. 하네스 검증 (계측기가 진짜로 잡는가) ===");

const NEGATIVE = `
function Broken(props) {
  const [a, setA] = useState(0);
  if (!props.ready) {
    return null;
  }
  const [b, setB] = useState(1);
  return <div />;
}
`;
const negFound = findHooksAfterEarlyReturn(NEGATIVE);
negFound.length === 1 && negFound[0].component === "Broken"
  ? ok("음성 대조군: 훅 사이의 조기 return 을 잡는다 (기대대로)")
  : bad(`음성 대조군이 안 잡혔다 — 계측기 고장: ${JSON.stringify(negFound)}`);

const POSITIVE = `
function Fine(props) {
  const [a, setA] = useState(0);
  const [b, setB] = useState(1);
  if (!props.ready) {
    return null;
  }
  return <div />;
}
`;
findHooksAfterEarlyReturn(POSITIVE).length === 0
  ? ok("양성 대조군: 훅 아래의 조기 return 은 통과한다 (너무 엄격하지 않다)")
  : bad("양성 대조군이 잘못 잡혔다 — 계측기가 과하게 엄격하다");

console.log("");
console.log("=== 2. 실제 ChatPanel.tsx (REQ-F6) ===");

const violations = findHooksAfterEarlyReturn(readFileSync(TARGET, "utf8"));
if (violations.length === 0) {
  ok("ChatPanel.tsx: 조기 return 이후의 훅 없음");
} else {
  for (const v of violations) {
    bad(`${v.component}() — ${v.firstReturn}행 조기 return 이후 훅: ${v.hooks.join(", ")}행`);
  }
  console.log("");
  console.log("  조기 return 을 모든 훅 아래로 내려라. 훅은 렌더마다 같은 개수로 실행되어야 한다.");
}

console.log("");
if (failed) {
  console.log(`FAIL — ${failed}건`);
  process.exit(1);
}
console.log("PASS — REQ-F6 훅 순서 정상");
