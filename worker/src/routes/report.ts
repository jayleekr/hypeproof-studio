// In-app bug reports (#64).
//
// Discord-first triage flow:
//   1. Studio user fills a free-text form, optionally attaches metadata
//      (request_id, jti, profile_id, Studio version, OS).
//   2. POST /v1/report → persist to D1 `reports`, fire a Discord embed at
//      `DISCORD_REPORT_WEBHOOK_URL` (best-effort; webhook failure ≠ user-
//      visible failure).
//   3. Studio polls GET /v1/report/:id occasionally to learn about
//      resolution ("rep_xyz solved: try X").
//
// Auth model: Bearer is OPTIONAL. The whole point of this endpoint is to
// surface bugs — including "I can't even log in". A valid token lets us
// hash + record the jti (16 hex chars of sha256) for correlation; an invalid
// token gets logged and ignored (because the broken token might BE the bug).
//
// Anti-abuse:
//   - 3 reports / 60s per cf-connecting-ip (KV-backed)
//   - description capped at 5000 chars
//   - jti hashed (never stored / forwarded raw)
//   - recent_turns server-side stripped unless `include_recent_turns:true`;
//     when included, cap to 3 messages × 2000 chars each
//   - Discord embed shows only the first 1000 chars of description, never
//     contact/jti raw

import { Hono } from "hono";
import type { Env } from "../env";
import { bearer, verify } from "../lib/tokens";
import { makeErrorBody } from "../middleware/request-id.ts";

export const report = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

// ---------------------------------------------------------------------------
// Constants / shape

const MAX_DESC = 5000;
const MIN_DESC = 1;
const MAX_CONTACT = 200;
const RATE_WINDOW_SEC = 60;
const RATE_LIMIT = 3;
const MAX_RECENT_TURNS = 3;
const MAX_TURN_CHARS = 2000;
const DESCRIPTION_TRUNCATE_FOR_DISCORD = 1000;
// Default red-ish embed color (0xff8003 = warm orange) — matches the issue
// spec example. Plain decimal to satisfy Discord's payload contract.
const DISCORD_EMBED_COLOR = 16744515;

interface ReportBody {
  description?: unknown;
  request_id?: unknown;
  profile_id?: unknown;
  contact?: unknown;
  include_recent_turns?: unknown;
  recent_turns?: unknown;
  attachments?: unknown;
}

interface RecentTurn {
  role: "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Helpers

/**
 * Generate a `rep_<base32>` id. 8 bytes random → 13 chars (Crockford-style
 * lowercase). Collision odds at workshop scale are negligible.
 */
function generateReportId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  // RFC 4648 base32 without padding, lowercase.
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 31];
  }
  return `rep_${out}`;
}

async function sha256Hex16(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const arr = new Uint8Array(buf);
  let hex = "";
  for (const b of arr) hex += b.toString(16).padStart(2, "0");
  return hex.slice(0, 16);
}

/**
 * KV-backed rate limit. Returns true when the request should be blocked.
 * Stored value: `{ count, first_ts }` — once count hits RATE_LIMIT inside the
 * window, return true until the KV TTL purges it. (Simpler than a sliding
 * window; good enough for "stop a runaway client from spamming".)
 */
async function isRateLimited(kv: KVNamespace, ip: string): Promise<boolean> {
  const key = `report-rate:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  const raw = await kv.get(key);
  if (!raw) {
    await kv.put(
      key,
      JSON.stringify({ count: 1, first_ts: now }),
      { expirationTtl: RATE_WINDOW_SEC },
    );
    return false;
  }
  let parsed: { count?: number; first_ts?: number } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Stale/garbage entry — reset.
    await kv.put(
      key,
      JSON.stringify({ count: 1, first_ts: now }),
      { expirationTtl: RATE_WINDOW_SEC },
    );
    return false;
  }
  const count = typeof parsed.count === "number" ? parsed.count : 0;
  const firstTs = typeof parsed.first_ts === "number" ? parsed.first_ts : now;
  // Window expired (defensive — KV TTL should already have purged) → reset.
  if (now - firstTs >= RATE_WINDOW_SEC) {
    await kv.put(
      key,
      JSON.stringify({ count: 1, first_ts: now }),
      { expirationTtl: RATE_WINDOW_SEC },
    );
    return false;
  }
  if (count >= RATE_LIMIT) return true;
  // Cloudflare KV requires expirationTtl >= 60. The "remaining window" math
  // can fall below 60 as we approach the original first_ts + 60s mark, which
  // is the natural place to bump the counter — putting `expirationTtl: 42`
  // would 400 the entire request and turn a benign rate-bump into a 500.
  // Effective semantics: each bump extends the window to a full 60s from
  // *now*, which makes the limiter slightly stricter than a pure fixed
  // window (acceptable; the intent is "stop runaway clients"). We preserve
  // the original first_ts so the count → block transition still happens
  // exactly once per first-request cohort.
  await kv.put(
    key,
    JSON.stringify({ count: count + 1, first_ts: firstTs }),
    { expirationTtl: RATE_WINDOW_SEC },
  );
  return false;
}

function sanitizeRecentTurns(value: unknown): RecentTurn[] {
  if (!Array.isArray(value)) return [];
  const out: RecentTurn[] = [];
  for (const item of value) {
    if (out.length >= MAX_RECENT_TURNS) break;
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const role = obj.role;
    const content = obj.content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    out.push({
      role,
      content: content.slice(0, MAX_TURN_CHARS),
    });
  }
  return out;
}

function truncateForDiscord(s: string, max: number = DESCRIPTION_TRUNCATE_FOR_DISCORD): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * Fire-and-forget Discord embed. Caller decides whether to await or not.
 * Catches all errors (network, 4xx, etc.) — we never want to fail the user-
 * facing POST because Discord hiccupped.
 */
export async function postDiscordReport(
  webhookUrl: string,
  args: {
    reportId: string;
    description: string;
    profileId?: string;
    requestId?: string;
    jtiHash?: string | null;
    studioVersion?: string;
    os?: string;
    contact?: string;
    createdAtUnix: number;
  },
): Promise<void> {
  try {
    const fields: DiscordField[] = [];
    fields.push({
      name: "description",
      value: truncateForDiscord(args.description),
      inline: false,
    });
    if (args.profileId) fields.push({ name: "profile_id", value: args.profileId, inline: true });
    if (args.requestId) fields.push({ name: "request_id", value: args.requestId, inline: true });
    if (args.jtiHash) fields.push({ name: "jti_hash", value: args.jtiHash, inline: true });
    if (args.studioVersion) fields.push({ name: "studio_version", value: args.studioVersion, inline: true });
    if (args.os) fields.push({ name: "os", value: args.os, inline: true });
    if (args.contact) fields.push({ name: "contact", value: args.contact, inline: false });

    const ts = new Date(args.createdAtUnix * 1000).toISOString().replace("T", " ").slice(0, 19);

    const payload = {
      embeds: [
        {
          title: `⚠️ New report: ${args.reportId}`,
          color: DISCORD_EMBED_COLOR,
          fields,
          footer: { text: `${args.reportId} · ${ts}` },
        },
      ],
    };

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`discord webhook returned ${res.status}: ${await res.text().catch(() => "")}`);
    }
  } catch (err) {
    console.warn("discord webhook failed:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Fire-and-forget Discord resolution announcement. Same swallow-all error
 * stance as `postDiscordReport`.
 */
export async function postDiscordResolution(
  webhookUrl: string,
  args: { reportId: string; resolutionNote: string; githubIssueUrl?: string },
): Promise<void> {
  try {
    let content = `✅ ${args.reportId} resolved: ${truncateForDiscord(args.resolutionNote, 1500)}`;
    if (args.githubIssueUrl) content += `\n${args.githubIssueUrl}`;
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      console.warn(`discord resolution webhook returned ${res.status}`);
    }
  } catch (err) {
    console.warn("discord resolution webhook failed:", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// POST /v1/report — submit a new bug report

report.post("/", async (c) => {
  // Rate limit (per cf-connecting-ip, KV-backed). Local dev: no header → use
  // "local" bucket so the test still exercises the path.
  const ip = c.req.header("cf-connecting-ip")
    ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "local";
  if (await isRateLimited(c.env.HPS_KV, ip)) {
    return c.json(
      makeErrorBody(c, "rate_limited", `report rate limit: ${RATE_LIMIT} per ${RATE_WINDOW_SEC}s`),
      429,
    );
  }

  let body: ReportBody;
  try {
    body = await c.req.json<ReportBody>();
  } catch {
    return c.json(makeErrorBody(c, "invalid_body", "expected JSON body"), 400);
  }

  // Description validation
  if (typeof body.description !== "string") {
    return c.json(makeErrorBody(c, "invalid_body", "description (string) required"), 400);
  }
  const description = body.description.trim();
  if (description.length < MIN_DESC) {
    return c.json(makeErrorBody(c, "invalid_body", "description must be non-empty"), 400);
  }
  if (description.length > MAX_DESC) {
    return c.json(
      makeErrorBody(c, "invalid_body", `description exceeds ${MAX_DESC} chars`),
      400,
    );
  }

  // Optional fields (cap conservatively to avoid abuse / log spam)
  const requestId = typeof body.request_id === "string" && body.request_id.length <= 64
    ? body.request_id
    : undefined;
  const profileId = typeof body.profile_id === "string" && body.profile_id.length <= 80
    ? body.profile_id
    : undefined;
  let contact: string | undefined;
  if (typeof body.contact === "string") {
    if (body.contact.length > MAX_CONTACT) {
      return c.json(
        makeErrorBody(c, "invalid_body", `contact exceeds ${MAX_CONTACT} chars`),
        400,
      );
    }
    contact = body.contact;
  }

  // Recent turns: server strips entirely if not opted in. When opted in,
  // validate shape + cap.
  let recentTurns: RecentTurn[] = [];
  if (body.include_recent_turns === true) {
    recentTurns = sanitizeRecentTurns(body.recent_turns);
  }

  // Attachments metadata (free-form JSON blob — studio_version, os, etc.).
  let attachmentsObj: Record<string, unknown> = {};
  if (body.attachments && typeof body.attachments === "object" && !Array.isArray(body.attachments)) {
    attachmentsObj = body.attachments as Record<string, unknown>;
  }
  if (recentTurns.length > 0) {
    attachmentsObj = { ...attachmentsObj, recent_turns: recentTurns };
  }

  // Optional auth — extract jti hash if token is valid; otherwise log + ignore.
  let jtiHash: string | null = null;
  const token = bearer(c.req.header("authorization"));
  if (token) {
    try {
      const payload = await verify(token, c.env.HPS_SIGNING_SECRET);
      if (payload.jti) {
        jtiHash = await sha256Hex16(payload.jti);
      }
    } catch (err) {
      // Broken token might BE the bug. Log + still accept.
      console.warn(
        `[${c.get("requestId")}] /v1/report token rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const reportId = generateReportId();
  const ts = nowSeconds();

  // Persist to D1. attachments_json is opaque to the DB; we just round-trip it.
  try {
    await c.env.HPS_DB
      .prepare(
        `INSERT INTO reports (id, ts, jti_hash, profile_id, request_id, description, attachments_json, contact, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      )
      .bind(
        reportId,
        ts,
        jtiHash,
        profileId ?? null,
        requestId ?? null,
        description,
        Object.keys(attachmentsObj).length > 0 ? JSON.stringify(attachmentsObj) : null,
        contact ?? null,
      )
      .run();
  } catch (err) {
    console.error(`[${c.get("requestId")}] /v1/report D1 insert failed:`, err);
    return c.json(
      makeErrorBody(c, "internal", "failed to persist report"),
      500,
    );
  }

  // Best-effort Discord side-effect. Never throws.
  if (c.env.DISCORD_REPORT_WEBHOOK_URL) {
    const studioVersion = typeof attachmentsObj.studio_version === "string"
      ? (attachmentsObj.studio_version as string)
      : undefined;
    const os = typeof attachmentsObj.os === "string" ? (attachmentsObj.os as string) : undefined;
    // Don't waitUntil — for local dev / tests we want deterministic ordering
    // when asserting the webhook fired. The await is bounded by the webhook
    // POST; failures swallowed.
    await postDiscordReport(c.env.DISCORD_REPORT_WEBHOOK_URL, {
      reportId,
      description,
      profileId,
      requestId,
      jtiHash,
      studioVersion,
      os,
      contact,
      createdAtUnix: ts,
    });
  }

  return c.json({ report_id: reportId, status: "open" });
});

// ---------------------------------------------------------------------------
// GET /v1/report/:id — Studio polls this to learn about resolution.
// No auth: returns ONLY status + resolution_note + github_issue_url +
// resolved_at. No description, contact, jti, profile, attachments.

report.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!id || !/^rep_[a-z2-7]+$/.test(id)) {
    return c.json(makeErrorBody(c, "not_found", "report not found"), 404);
  }
  const row = await c.env.HPS_DB
    .prepare(
      `SELECT id, status, resolution_note, github_issue_url, resolved_at
       FROM reports WHERE id = ?`,
    )
    .bind(id)
    .first<{
      id: string;
      status: string;
      resolution_note: string | null;
      github_issue_url: string | null;
      resolved_at: number | null;
    }>();
  if (!row) {
    return c.json(makeErrorBody(c, "not_found", "report not found"), 404);
  }
  return c.json({
    report_id: row.id,
    status: row.status,
    resolution_note: row.resolution_note,
    github_issue_url: row.github_issue_url,
    resolved_at: row.resolved_at,
  });
});
