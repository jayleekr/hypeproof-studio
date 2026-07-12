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
