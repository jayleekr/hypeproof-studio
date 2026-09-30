// Element → AI (CR-09, CR-60; recon R2).
//
// The student picks a rendered element in the Experiment Browser (the CDP inspector:
// `Overlay.setInspectMode` `searchForNode` → `Overlay.inspectNodeRequested`). The payload
// is built from the picked `backendNodeId`:
//   - the same `[ref=eN]` the observation snapshot gives that node (a new ref in the same
//     table when the snapshot has none, so the agent can act on it next);
//   - a bounded `DOM.getOuterHTML` snippet;
//   - a computed-style subset (`CSS.getComputedStyleForNode`);
//   - an element crop (`Page.captureScreenshot` clipped to the border box, never the page);
//   - a source mapping: the page URL path resolved inside the served root, then the
//     element located in that file's MARKUP by id or by its exact text. Script and style
//     bodies are blanked first, so an element an inline script generates is "unmapped",
//     never a guessed file or line.
// It rides the existing page-context conduit; the student sees it and can remove it
// before sending. Local processing time is measured for CR-60.
//
// Pure and vscode-free (Node fs for the source file).

import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { buildAxSnapshot } from "./browserControlHelpers.ts";
import { resolveWithinRoot } from "./liveServerHelpers.ts";
import {
  routeOf,
  type ArtifactVersionRef,
  type CdpLike,
  type PageEventLog,
} from "./experimentBrowser.ts";

export const SNIPPET_MAX = 1500;
export const STYLE_KEYS = [
  "display",
  "visibility",
  "opacity",
  "position",
  "width",
  "height",
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "line-height",
  "text-align",
  "padding",
  "margin",
  "border",
  "cursor",
  "pointer-events",
  "z-index",
] as const;

export type SourceMapping = { file: string; line: number } | "unmapped";

export interface ElementContext {
  ref: string;
  backendNodeId: number;
  tag: string;
  text: string;
  snippet: string;
  snippetTruncated: boolean;
  style: Record<string, string>;
  crop: { mimeType: "image/png"; data: string; clip: { x: number; y: number; width: number; height: number } } | null;
  source: SourceMapping;
  url: string;
  route: string;
  documentGeneration: string;
  artifact: ArtifactVersionRef;
  /** Local processing from the pick event to a ready payload (CR-60), milliseconds. */
  captureMs: number;
}

/** Enter inspect mode and wait for the student's click; returns the picked node. */
export async function waitForPick(cdp: CdpLike, timeoutMs = 60_000): Promise<number> {
  await cdp.send("DOM.enable", {});
  await cdp.send("Overlay.enable", {});
  let sub: { dispose(): void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const picked = new Promise<number>((resolve, reject) => {
    sub = cdp.onEvent((e) => {
      if (e.method === "Overlay.inspectNodeRequested" && Number.isFinite(e.params.backendNodeId)) resolve(Number(e.params.backendNodeId));
    });
    timer = setTimeout(() => reject(new Error("요소를 고르지 않아 선택을 끝냈어요.")), timeoutMs);
  });
  try {
    await cdp.send("Overlay.setInspectMode", {
      mode: "searchForNode",
      highlightConfig: {
        showInfo: true,
        contentColor: { r: 111, g: 168, b: 220, a: 0.35 },
        borderColor: { r: 255, g: 122, b: 0, a: 0.9 },
      },
    });
    return await picked;
  } finally {
    sub?.dispose();
    if (timer) clearTimeout(timer);
    await cdp.send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} }).catch(() => {});
  }
}

const ELEMENT_FACTS = `function(){
  var norm = function(el){ return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(); };
  var t = norm(this);
  var twins = 0;
  try {
    var same = this.ownerDocument.getElementsByTagName(this.tagName);
    for (var i = 0; i < same.length; i++) if (norm(same[i]) === t) twins++;
  } catch (e) { twins = 0; }
  return { tag: String(this.tagName || '').toLowerCase(), id: this.id || '', text: t.slice(0, 200), twins: twins };
}`;

/**
 * Build the payload for a picked node. `refs` is the shared ref table (the executor's):
 * `refFor` answers an existing ref, `adopt` installs a fresh snapshot's table.
 */
export async function buildElementContext(
  cdp: CdpLike,
  log: PageEventLog,
  backendNodeId: number,
  deps: {
    root: string | null;
    artifactVersion(url: string): Promise<ArtifactVersionRef>;
    refFor(backendNodeId: number): string | null;
    adopt(refs: Map<string, number>, generation: string): void;
    now?: () => number;
  },
): Promise<ElementContext> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  const generation = log.documentGeneration ?? "";
  // The ref: the observation's own label for this node, else a new one in the same table.
  const ax = await cdp.send("Accessibility.getFullAXTree", {});
  const { refs } = buildAxSnapshot(Array.isArray(ax?.nodes) ? ax.nodes : []);
  let ref: string | null = null;
  for (const [r, id] of refs) if (id === backendNodeId) ref = r;
  if (!ref) {
    ref = `e${refs.size + 1}`;
    refs.set(ref, backendNodeId);
  }
  deps.adopt(refs, generation);

  const resolved = await cdp.send("DOM.resolveNode", { backendNodeId });
  const objectId = resolved?.object?.objectId;
  const factsRes = objectId
    ? await cdp.send("Runtime.callFunctionOn", { objectId, functionDeclaration: ELEMENT_FACTS, returnByValue: true })
    : null;
  const facts = factsRes?.result?.value ?? { tag: "", id: "", text: "" };

  const outer = await cdp.send("DOM.getOuterHTML", { backendNodeId });
  const html = String(outer?.outerHTML ?? "");

  const style: Record<string, string> = {};
  try {
    await cdp.send("CSS.enable", {});
    await cdp.send("DOM.getDocument", { depth: 0 });
    const pushed = await cdp.send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [backendNodeId] });
    const nodeId = pushed?.nodeIds?.[0];
    if (nodeId) {
      const computed = await cdp.send("CSS.getComputedStyleForNode", { nodeId });
      for (const p of computed?.computedStyle ?? []) {
        if ((STYLE_KEYS as readonly string[]).includes(p.name)) style[p.name] = String(p.value);
      }
    }
  } catch {
    /* style is a subset by design; an empty subset is shown as such */
  }

  const crop = await cropElement(cdp, backendNodeId);

  const loc = await cdp.send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
  const url = String(loc?.result?.value ?? "");
  const artifact = await deps.artifactVersion(url);
  const source = deps.root ? await mapSourceFromUrl(deps.root, url, facts) : "unmapped";

  return {
    ref,
    backendNodeId,
    tag: String(facts.tag ?? ""),
    text: String(facts.text ?? ""),
    snippet: html.slice(0, SNIPPET_MAX),
    snippetTruncated: html.length > SNIPPET_MAX,
    style,
    crop,
    source,
    url,
    route: routeOf(url),
    documentGeneration: generation,
    artifact,
    captureMs: Math.round(now() - started),
  };
}

/** A PNG of the element's border box only (page coordinates = viewport + scroll). */
export async function cropElement(cdp: CdpLike, backendNodeId: number): Promise<ElementContext["crop"]> {
  await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
  const box = await cdp.send("DOM.getBoxModel", { backendNodeId }).catch(() => null);
  const q: number[] | undefined = box?.model?.border;
  if (!Array.isArray(q) || q.length < 8) return null;
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  const metrics = await cdp.send("Page.getLayoutMetrics", {}).catch(() => null);
  const vp = metrics?.cssLayoutViewport ?? metrics?.layoutViewport ?? {};
  const clip = {
    x: Math.min(...xs) + (Number(vp.pageX) || 0),
    y: Math.min(...ys) + (Number(vp.pageY) || 0),
    width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
    height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
  };
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } }).catch(() => null);
  const data = String(shot?.data ?? "");
  return data ? { mimeType: "image/png", data, clip } : null;
}

/** Blank script/style bodies and comments, keeping every newline so lines still count. */
function markupOnly(html: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_m, a, b, c) => a + blank(b) + c)
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, a, b, c) => a + blank(b) + c);
}

const norm = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

/**
 * Where in `html` is the element defined? By id when it has one, else by its exact text
 * inside a same-tag element. One match or nothing: two candidates are a guess, and a
 * guess is "unmapped". An element with an id no markup defines was made by a script, so
 * it is "unmapped" too (never matched by text to some other element). `twins` is how
 * many same-tag elements in the live page carry the same text: more than one means a
 * text match cannot tell them apart, so it is not tried.
 */
export function mapSource(html: string, fileRel: string, el: { tag: string; id?: string; text?: string; twins?: number }): SourceMapping {
  const tag = (el.tag || "").toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return "unmapped";
  const markup = markupOnly(html);
  if (el.id) {
    const re = new RegExp(`<${tag}\\b[^>]*\\bid\\s*=\\s*["']${escapeRe(el.id)}["']`, "gi");
    const hits = [...markup.matchAll(re)];
    if (hits.length === 1) return { file: fileRel, line: lineAt(markup, hits[0].index ?? 0) };
    return "unmapped";
  }
  if (typeof el.twins === "number" && el.twins > 1) return "unmapped";
  const want = norm(el.text ?? "");
  if (!want) return "unmapped";
  const open = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const hits: number[] = [];
  for (const m of markup.matchAll(open)) {
    const start = (m.index ?? 0) + m[0].length;
    const end = markup.toLowerCase().indexOf(`</${tag}>`, start);
    if (end < 0) continue;
    if (norm(markup.slice(start, end)) === want) hits.push(m.index ?? 0);
  }
  return hits.length === 1 ? { file: fileRel, line: lineAt(markup, hits[0]) } : "unmapped";
}

async function mapSourceFromUrl(root: string, url: string, el: { tag: string; id?: string; text?: string; twins?: number }): Promise<SourceMapping> {
  let pathname: string;
  try {
    const u = new URL(url);
    pathname = u.pathname === "/__hp_viewport" ? (u.searchParams.get("path") || "/").split(/[?#]/)[0] : u.pathname;
  } catch {
    return "unmapped";
  }
  let abs = resolveWithinRoot(root, pathname);
  if (!abs) return "unmapped";
  const st = await fsp.stat(abs).catch(() => null);
  if (st?.isDirectory()) abs = path.join(abs, "index.html");
  if (!/\.html?$/i.test(abs)) return "unmapped";
  const html = await fsp.readFile(abs, "utf8").catch(() => null);
  if (html === null) return "unmapped";
  return mapSource(html, path.relative(path.resolve(root), abs).split(path.sep).join("/"), el);
}

/** What the coach reads. The crop rides separately as the image. */
export function elementContextText(ctx: ElementContext): string {
  const style = Object.entries(ctx.style).map(([k, v]) => `${k}: ${v}`).join("; ");
  const src = ctx.source === "unmapped" ? "unmapped (소스 파일을 확실히 찾지 못했어요 — 추측하지 마세요)" : `${ctx.source.file}:${ctx.source.line}`;
  return [
    "[학생이 고른 화면 요소]",
    `ref: ${ctx.ref} (문서 세대 ${ctx.documentGeneration})`,
    `페이지: ${ctx.url} (경로 ${ctx.route})`,
    `산출물 버전: ${ctx.artifact.id}`,
    `요소: <${ctx.tag}> ${ctx.text ? JSON.stringify(ctx.text) : ""}`.trim(),
    `소스 위치: ${src}`,
    `계산된 스타일: ${style || "(없음)"}`,
    `HTML${ctx.snippetTruncated ? " (앞부분)" : ""}:`,
    ctx.snippet,
    "학생의 질문은 이 요소에 대한 것입니다.",
  ].join("\n");
}

/**
 * CR-T09 / CR-T56 checks on a payload. Problems, empty = passes:
 *   - the ref must name the picked node in the shared table (a different element's ref fails);
 *   - the crop must be the element, not the page (a full-viewport crop of a smaller element fails);
 *   - local processing must be under `maxMs` (CR-60: 1000).
 */
export function elementContextProblems(
  ctx: ElementContext,
  opts: { refTarget(ref: string): number | undefined; viewport?: { width: number; height: number }; maxMs?: number },
): string[] {
  const problems: string[] = [];
  if (opts.refTarget(ctx.ref) !== ctx.backendNodeId) problems.push(`ref ${ctx.ref} does not name the picked node`);
  if (!ctx.crop) problems.push("no element crop");
  else if (opts.viewport) {
    const full = ctx.crop.clip.width >= opts.viewport.width && ctx.crop.clip.height >= opts.viewport.height;
    if (full) problems.push("crop covers the whole viewport, not the element");
  }
  if (ctx.source !== "unmapped" && !(ctx.source.line >= 1 && ctx.source.file)) problems.push("malformed source mapping");
  if (opts.maxMs !== undefined && !(ctx.captureMs < opts.maxMs)) problems.push(`capture took ${ctx.captureMs} ms (limit ${opts.maxMs})`);
  return problems;
}
