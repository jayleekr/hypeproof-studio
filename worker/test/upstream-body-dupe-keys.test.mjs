// 드리프트 락 — 조건부 스프레드가 최상위 키를 조용히 덮는 형태를 잡는다 (#670).
//
// 문제의 모양:
//
//   const upstreamBody = {
//     ...raw,
//     ...(profile.minor_cohort === true ? { max_tokens: 12000 } : {}),   // ← 죽는다
//     max_tokens: clampMaxTokens(...),                                   // ← 이긴다
//   };
//
// JS 객체 리터럴은 뒤 키가 이긴다. 그래서 미성년 출력 상한이 한 번도 적용된 적이
// 없었고, 아이들은 12000 이 아니라 16384 로 돌았다 (2026-08-22 SK 1회차: 6명이
// 정확히 그 천장에 붙었고 해당 호출 지연이 153~262초).
//
// **타입체크도 린트도 이걸 안 잡는다.** TS 는 스프레드가 낀 중복을 오류로 보지
// 않고, ESLint `no-dupe-keys` 도 스프레드는 건너뛴다. 그래서 별도 락이 필요하다.
//
// 실행: node --experimental-strip-types test/upstream-body-dupe-keys.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 주석과 문자열을 지운다 — 그 안의 중괄호가 깊이 계산을 망가뜨린다. */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

/** `const <name> = {` 부터 짝이 맞는 `}` 까지의 본문을 돌려준다. */
function objectLiteral(src, name) {
  const start = src.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `${name} 리터럴을 못 찾았다 (이름이 바뀌었나?)`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  assert.fail(`${name} 리터럴의 닫는 괄호를 못 찾았다`);
}

/** 주어진 본문에서 **깊이 0** 의 키 이름만 뽑는다. */
function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  let atKeyPos = true;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (depth === 0) {
      if (ch === ",") atKeyPos = true;
      else if (atKeyPos && /[A-Za-z_$]/.test(ch)) {
        const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i));
        if (m) keys.push(m[1]);
        atKeyPos = false;
      } else if (!/\s/.test(ch)) atKeyPos = false;
    }
  }
  return keys;
}

/** 깊이 0 의 `...( … ? { … } : { … })` 안에 든 객체 본문들. */
function conditionalSpreadBodies(body) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (depth === 0 && body.startsWith("...(", i)) {
      // 이 스프레드의 괄호 범위를 잡는다.
      let d = 0;
      let j = i + 3;
      for (; j < body.length; j++) {
        if (body[j] === "(") d++;
        else if (body[j] === ")") {
          d--;
          if (d === 0) break;
        }
      }
      const inner = body.slice(i + 4, j);
      // 그 안의 깊이 0 객체 리터럴들
      let k = 0;
      let od = 0;
      let start = -1;
      for (; k < inner.length; k++) {
        if (inner[k] === "{") {
          if (od === 0) start = k;
          od++;
        } else if (inner[k] === "}") {
          od--;
          if (od === 0 && start >= 0) {
            out.push(inner.slice(start + 1, k));
            start = -1;
          }
        }
      }
      i = j;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
  }
  return out;
}

export function findShadowedKeys(source, literalName) {
  const src = strip(source);
  const body = objectLiteral(src, literalName);
  const top = new Set(topLevelKeys(body));
  const shadowed = [];
  for (const inner of conditionalSpreadBodies(body)) {
    for (const k of topLevelKeys(inner)) {
      if (top.has(k)) shadowed.push(k);
    }
  }
  return [...new Set(shadowed)];
}

// ── 대조군 — 계측기가 실제로 잡는지 먼저 확인한다 ─────────────────────────────
// (rules/verification.md §2 — 통과·실패를 못 가르는 TC 는 아무것도 지키지 않는다)
{
  const bad = `
    const upstreamBody = {
      ...raw,
      model: modelLabel,
      ...(profile.minor_cohort === true ? { output_config: { effort: "medium" }, max_tokens: 12000 } : {}),
      messages: msgs,
      max_tokens: clampMaxTokens(raw.max_tokens, profile),
      stream,
    };
  `;
  const hits = findShadowedKeys(bad, "upstreamBody");
  assert.deepEqual(hits, ["max_tokens"], "음성 대조군: #670 이전 모양을 잡아야 한다");
}
console.log("✓ 음성 대조군: 조건부 스프레드가 덮이는 형태를 잡는다");

{
  const good = `
    const upstreamBody = {
      ...raw,
      ...(profile.minor_cohort === true ? { output_config: { effort: "medium" } } : {}),
      max_tokens: resolvedMaxTokens,
      stream,
    };
  `;
  assert.deepEqual(findShadowedKeys(good, "upstreamBody"), [], "양성 대조군: 정상 형태는 통과해야 한다");
}
console.log("✓ 양성 대조군: 단일 지점 형태는 통과한다");

// ── 실물 ────────────────────────────────────────────────────────────────────
{
  const file = join(here, "..", "src", "routes", "messages.ts");
  const hits = findShadowedKeys(readFileSync(file, "utf8"), "upstreamBody");
  assert.deepEqual(
    hits,
    [],
    `messages.ts upstreamBody: 조건부 스프레드의 키가 아래 최상위 키에 덮인다 — ${hits.join(", ")}. ` +
      `그 스프레드 안의 값은 절대 상류에 도달하지 않는다(#670). 값을 한 곳에서 계산해 단일 키로 넘겨라.`,
  );
}
console.log("✓ messages.ts upstreamBody: 덮이는 키 없음");

console.log("All upstream-body dupe-key checks passed.");
