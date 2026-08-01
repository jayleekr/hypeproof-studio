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

const LOOPBACK_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$|\?|#)/i;

/**
 * 이 주소가 **학생 자기 컴퓨터**인가 (라이브 프리뷰 서버).
 *
 * 정규화 후에 판정한다 — 코치는 `127.0.0.1:51884` 처럼 스킴 없이 넘기기도 하고,
 * safeNavigateUrl 이 그걸 `http://` 로 채운다. 원문에 정규식을 걸면 그 경우를
 * 놓친다.
 */
export function isLoopbackUrl(input: string): boolean {
  const url = safeNavigateUrl(input);
  return !!url && LOOPBACK_URL.test(url);
}

/**
 * 승인 기억용 키. `https://boaclinic.com/about` → `https://boaclinic.com`.
 * 서브페이지마다 다시 묻지 않기 위한 것이므로 **오리진 단위**다 — 경로가 아니라.
 * 정규화에 실패하면 null 을 돌려주고, 호출부는 기억하지 않고 매번 묻는다.
 */
export function originOfUrl(input: string): string | null {
  const url = safeNavigateUrl(input);
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * 코치 브라우징의 **슬롯**. 두 개뿐이고, 서로를 절대 침범하지 않는다.
 *
 * 왜 둘인가: 카피클론 커리큘럼이 "정답지와 내 결과물을 **비교**"를 요구한다
 * (`prompts/boah-dental-director-copyclone-2026-s1.md:107-109`). 한 탭으로 합치면
 * 나란히 볼 수가 없다.
 */
export type CoachTabSlot = "preview" | "reference";

/** 이 주소가 어느 슬롯에 속하나. 루프백 = 학생 결과물, 나머지 = 참고 사이트. */
export function coachTabSlot(url: string): CoachTabSlot {
  return isLoopbackUrl(url) ? "preview" : "reference";
}

/** `planCoachBrowserTabs` 의 결과 — 어느 탭을 재사용하고 어느 탭을 닫을지. */
export interface CoachTabPlan {
  /** 이동(CDP navigate)시킬 기존 탭의 인덱스. null 이면 새 탭을 하나 연다. */
  reuse: number | null;
  /** 정리할 탭 인덱스 (같은 슬롯의 잉여분만). */
  close: number[];
}

/**
 * 코치가 새 주소로 갈 때 **어느 탭을 이동시키고 어느 탭을 닫을지** 정한다 (#519).
 *
 * 전신은 `coachTabsToClose` 였다. 그 함수는 "바깥 주소 탭 1개 유지"만 보장했고,
 * 두 군데가 틀려 있었다 (2026-08-01 대조군 관측):
 *
 *   1. 루프백을 정리 대상에서 **통째로** 뺐다. "루프백 = 라이브 프리뷰 하나"라는
 *      가정이었는데, 코치가 결과물의 하위 페이지(`/about.html`, `/contact.html`)를
 *      돌아다니는 순간 깨진다 — 4번 탐색에 탭 4개가 쌓였다. 같은 URL 재방문조차
 *      중복됐다(#415 dedup 은 **활성** 탭에만 걸리므로 여기까지 못 온다).
 *   2. 다음 주소가 루프백일 때도 **바깥 주소 탭을 전부 닫았다.** 참가자가 보던
 *      정답지가 코치의 프리뷰 탐색 한 번에 사라진다 — 커리큘럼이 요구하는 "나란히
 *      비교"가 코드에서 깨져 있었다.
 *
 * 새 규칙 — 슬롯당 탭 하나, 슬롯 간 불간섭:
 *   - 같은 슬롯에 탭이 있으면 **그 탭을 재사용**한다(닫고 새로 여는 게 아니라
 *     CDP 로 이동 → 탭·컬럼이 늘지 않고 페이지 히스토리가 살아 있다).
 *     같은 URL 인 탭이 있으면 그것을 우선 고른다.
 *   - 같은 슬롯의 **잉여** 탭만 닫는다(이미 쌓인 레거시 정리).
 *   - **다른 슬롯 탭은 건드리지 않는다.** 정답지와 결과물은 공존해야 한다.
 *
 * 결과적으로 코치 탐색이 몇 번이든 탭 총수는 슬롯 수(2)를 넘지 않는다.
 */
export function planCoachBrowserTabs(
  tabUrls: readonly (string | undefined)[],
  nextUrl: string,
): CoachTabPlan {
  const slot = coachTabSlot(nextUrl);
  const sameSlot: number[] = [];
  for (let i = 0; i < tabUrls.length; i++) {
    const u = tabUrls[i];
    if (!u) continue;
    if (coachTabSlot(u) === slot) sameSlot.push(i);
  }
  if (sameSlot.length === 0) return { reuse: null, close: [] };
  // 같은 주소인 탭이 있으면 그것을 재사용한다 — 이동조차 필요 없는 경우가 되고,
  // 참가자가 보고 있던 화면을 그대로 둔다.
  const exact = sameSlot.find((i) => isSameBrowserUrl(tabUrls[i] as string, nextUrl));
  const reuse = exact ?? sameSlot[0];
  return { reuse, close: sameSlot.filter((i) => i !== reuse) };
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
