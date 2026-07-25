// #278 Phase 3 — pure (vscode-free) helpers for the browser control executor,
// so the tricky bits (URL whitelist, AX-snapshot ref assignment, click-point
// math) are unit-testable under `node --strip-types`. See browserControl.ts.

// Roles whose nodes get a clickable/typeable [ref=eN] in the read snapshot.
const INTERACTIVE_ROLES = new Set<string>([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
]);

// Roles surfaced as plain text context (no ref — not interactive).
const TEXT_ROLES = new Set<string>(["heading", "StaticText", "paragraph", "text"]);

const NAV_SCHEME = /^(https?|file):\/\//i;
const LOCALHOST = /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i;

/**
 * Whitelist a navigation URL. Returns a normalized absolute URL, or null for
 * disallowed schemes (javascript:, vscode:, data:, etc.) — the coach must not
 * be able to drive the browser to a hostile scheme.
 */
export function safeNavigateUrl(input: string): string | null {
  const v = (input ?? "").trim();
  if (!v) return null;
  if (NAV_SCHEME.test(v)) return v;
  if (LOCALHOST.test(v)) return `http://${v}`;
  if (v.startsWith("/")) return null; // ambiguous local path — require file:// explicitly
  // A bare host like "example.com" → https. Reject anything with a scheme we
  // didn't whitelist above (contains "://" but wasn't http/https/file).
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !NAV_SCHEME.test(v)) return null;
  if (/^[\w.-]+(\.[a-z]{2,})(\/|$|:)/i.test(v)) return `https://${v}`;
  return null;
}

/**
 * #415 — 같은 페이지인지 비교하기 위한 정규화. 브라우저가 실제로 보여주는 URL
 * (`tab.url`)과 코치가 요청한 URL 은 표기가 조금씩 다르다: 끝 슬래시가 붙거나
 * (`http://127.0.0.1:5432` vs `.../`), 스킴/호스트 대소문자가 다르거나, 빈
 * `?`·`#` 이 따라붙는다. 그 표기 차이 때문에 "이미 열려 있다"를 놓치면 탭이
 * 중복으로 열리고 학생은 승인 모달을 한 번 더 눌러야 한다.
 *
 * 의도적으로 하지 않는 것: query·hash 는 살린다(다른 화면일 수 있다),
 * localhost ↔ 127.0.0.1 은 같다고 보지 않는다(추측이 늘수록 "열었는데 안 열림"
 * 오탐이 생긴다 — 단순함 유지).
 */
export function normalizeBrowserUrl(input: string): string {
  const v = (input ?? "").trim();
  if (!v) return "";
  try {
    const u = new URL(v);
    // pathname 끝 슬래시 제거 ("/" → "", "/a/" → "/a"); 빈 search/hash 는 버린다.
    const path = u.pathname.replace(/\/+$/, "");
    const search = u.search === "?" ? "" : u.search;
    const hash = u.hash === "#" ? "" : u.hash;
    return `${u.protocol}//${u.host}${path}${search}${hash}`;
  } catch {
    // 파싱 불가(상대 경로 등) → 소문자 + 끝 슬래시 제거 수준으로만 비교.
    return v.toLowerCase().replace(/\/+$/, "");
  }
}

/** 두 URL 이 "같은 페이지"인가 (표기 차이 무시). 빈 문자열은 항상 false. */
export function isSameBrowserUrl(a: string, b: string): boolean {
  const na = normalizeBrowserUrl(a);
  const nb = normalizeBrowserUrl(b);
  return na !== "" && na === nb;
}

/** Center point of a CDP box-model content quad [x1,y1,…,x4,y4]. */
export function quadCenter(quad: number[]): { x: number; y: number } | null {
  if (!Array.isArray(quad) || quad.length < 8 || quad.some((n) => typeof n !== "number")) return null;
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  };
}

interface AxNode {
  role?: { value?: string };
  name?: { value?: string };
  backendDOMNodeId?: number;
  ignored?: boolean;
}

/**
 * Turn an Accessibility.getFullAXTree node list into a compact text snapshot the
 * model can read, plus a `ref → backendDOMNodeId` map for click/type. Interactive
 * nodes get `[ref=eN] role "name"`; headings/text are included as context.
 */
export function buildAxSnapshot(
  nodes: AxNode[],
  opts: { maxLines?: number } = {},
): { text: string; refs: Map<string, number> } {
  const maxLines = opts.maxLines ?? 200;
  const refs = new Map<string, number>();
  const lines: string[] = [];
  let n = 0;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || node.ignored) continue;
    const role = node.role?.value ?? "";
    const name = (node.name?.value ?? "").trim();
    const backendId = node.backendDOMNodeId;
    if (INTERACTIVE_ROLES.has(role) && typeof backendId === "number") {
      const ref = `e${++n}`;
      refs.set(ref, backendId);
      lines.push(`[ref=${ref}] ${role}${name ? ` ${JSON.stringify(name)}` : ""}`);
    } else if (name && TEXT_ROLES.has(role)) {
      lines.push(`${role}: ${name}`);
    }
    if (lines.length >= maxLines) break;
  }
  return { text: lines.join("\n") || "(상호작용 요소를 찾지 못했어요)", refs };
}
