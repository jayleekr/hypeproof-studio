// #811 — the image boundary on the Agent SDK path (`/v1/messages`).
//
// The proxy path (`/v1/chat/completions` → lib/translate.ts) has had an image
// filter since the copyclone work: `filterMessages(body, profile.input
// ?.image_paste === true, …)` drops image blocks for a cohort that did not
// opt in, and `sanitizeContentBlocks` caps image count and size. The Agent SDK
// path had NEITHER — the word "image" did not appear in routes/messages.ts.
//
// That mattered because the assumption that covered it was wrong. The
// 2026-08-11 decision changed "minors always go through proxy" to "minors go
// through proxy unless the profile says otherwise", and BOTH registered child
// cohorts say otherwise (`coach_runtime: "agent-sdk"`). The children were on
// the path with no filter, and neither cohort sets `input.image_paste`.
//
// ── What this filters, and what it must never touch ─────────────────────────
//
// The discriminator is STRUCTURAL, not role-based. In the Anthropic schema a
// tool's output comes back inside a `user`-role message, as a `tool_result`
// block, so "user role → filter" would cut the browser screenshot loop that
// adult cohorts with `sdk_tools.browser` depend on. The proxy filter has the
// same split, spelled `allowToolBlocks`.
//
//   - an `image` block DIRECTLY in a message's content array → USER-PROVIDED.
//     Dropped unless `input.image_paste` is on.
//   - an `image` block inside `tool_result.content` → AGENT-GENERATED (the
//     MCP screenshot the coach asked for). NEVER dropped, whatever the
//     cohort's image_paste says — the browser_control grant governs it.
//
// ── Why the caps apply to both ──────────────────────────────────────────────
//
// Count and size are not a policy question. An unbounded number of unbounded
// images is a cost and abuse surface for every cohort, adult included, and the
// values here are the proxy's — a real screenshot is far under them, and
// anything over them is larger than Anthropic accepts anyway.
//
// ── Why it reports ──────────────────────────────────────────────────────────
//
// The reason this was left undone (#811) is that a wrong filter would break
// the screenshot loop *quietly*. So nothing here is silent: the caller gets a
// per-request count of what was dropped and why, logs it, and puts it on the
// response. A broken screenshot loop then shows up as `tool_result_capped`
// rather than as a coach that mysteriously stopped seeing the page.

/** Proxy parity — lib/translate.ts MAX_IMAGES_PER_TURN. */
export const MAX_IMAGES_PER_BLOCK_ARRAY = 4;
/** Proxy parity — lib/translate.ts MAX_IMAGE_DATAURL_CHARS (~4.8MB decoded). */
export const MAX_IMAGE_SOURCE_CHARS = 6_500_000;

export interface InboundImagePolicy {
  /** `profile.input.image_paste === true` — may the participant send images? */
  allowUserImages: boolean;
}

export interface InboundImageReport {
  /** User-provided image blocks dropped because the cohort did not opt in. */
  user_dropped: number;
  /** User-provided image blocks dropped by the count or size cap. */
  user_capped: number;
  /** Agent-generated (tool_result) image blocks dropped by a cap. Should be 0. */
  tool_result_capped: number;
}

export interface InboundImageResult {
  messages: unknown;
  report: InboundImageReport;
  /** True when anything at all was removed — the caller announces it. */
  touched: boolean;
}

function isImageBlock(b: unknown): b is { type: "image"; source?: unknown } {
  return !!b && typeof b === "object" && (b as { type?: unknown }).type === "image";
}

/** Length of the payload an image block carries, for the size cap. */
function imageSourceChars(block: { source?: unknown }): number {
  const src = block.source;
  if (!src || typeof src !== "object") return 0;
  const s = src as { data?: unknown; url?: unknown };
  if (typeof s.data === "string") return s.data.length;
  if (typeof s.url === "string") return s.url.length;
  return 0;
}

/**
 * Apply the caps to one content array's image blocks.
 *
 * `allowAny` false drops every image block (the user-provided, not-opted-in
 * case). Returns the kept blocks plus what each counter should be raised by.
 */
function capBlocks(
  blocks: unknown[],
  allowAny: boolean,
): { kept: unknown[]; dropped: number; capped: number; touched: boolean } {
  const kept: unknown[] = [];
  let images = 0;
  let dropped = 0;
  let capped = 0;
  for (const b of blocks) {
    if (!isImageBlock(b)) {
      kept.push(b);
      continue;
    }
    if (!allowAny) {
      dropped++;
      continue;
    }
    if (images >= MAX_IMAGES_PER_BLOCK_ARRAY || imageSourceChars(b) > MAX_IMAGE_SOURCE_CHARS) {
      capped++;
      continue;
    }
    images++;
    kept.push(b);
  }
  return { kept, dropped, capped, touched: dropped + capped > 0 };
}

/**
 * Filter user-provided images out of an Anthropic-shaped `messages` array and
 * cap image count/size on both sides of the tool boundary.
 *
 * Pure and total, like scrubToolResultSecrets: anything that is not the
 * expected shape is returned unchanged, so a provider-side format change
 * degrades to "no filtering" rather than to a 500 on the classroom's hot path.
 * (A shape this does not recognise is also a shape the cap cannot be trusted
 * on — that is why the report is surfaced instead of assumed clean.)
 */
export function filterInboundImages(messages: unknown, policy: InboundImagePolicy): InboundImageResult {
  const report: InboundImageReport = { user_dropped: 0, user_capped: 0, tool_result_capped: 0 };
  if (!Array.isArray(messages)) return { messages, report, touched: false };

  let any = false;
  const out = messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    const msg = m as { content?: unknown };
    if (!Array.isArray(msg.content)) return m;

    // Pass 1 — agent-generated images, inside tool_result. Capped, never dropped.
    let innerTouched = false;
    const afterTool = msg.content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as { type?: unknown; content?: unknown };
      if (b.type !== "tool_result" || !Array.isArray(b.content)) return block;
      const r = capBlocks(b.content, true);
      if (!r.touched) return block;
      report.tool_result_capped += r.capped;
      innerTouched = true;
      return { ...b, content: r.kept };
    });

    // Pass 2 — the participant's own images, at the top level of the turn.
    const top = capBlocks(afterTool, policy.allowUserImages);
    report.user_dropped += top.dropped;
    report.user_capped += top.capped;

    if (!innerTouched && !top.touched) return m;
    any = true;
    return { ...msg, content: top.kept };
  });

  return { messages: any ? out : messages, report, touched: any };
}

/** One-line summary for a log or a response header; null when nothing moved. */
export function summarizeImageReport(r: InboundImageReport): string | null {
  const parts: string[] = [];
  if (r.user_dropped) parts.push(`user_dropped=${r.user_dropped}`);
  if (r.user_capped) parts.push(`user_capped=${r.user_capped}`);
  if (r.tool_result_capped) parts.push(`tool_result_capped=${r.tool_result_capped}`);
  return parts.length ? parts.join(" ") : null;
}
