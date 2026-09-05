// studio-logs READ path — arrival check, roster diff, retrieval (#680, plan task I).
//
// The write side is worker/src/routes/logs.ts (PUT /v1/logs/...). Until this
// file existed, `studio-logs/` was write-only: nothing in the repo listed or
// read it. Confirming whether the 1회차 (2026-08-22) logs had even arrived took
// twelve days and was done by eyeballing the Cloudflare dashboard. When it was
// finally checked the arrival was partial, and the missing set was not random:
//
//   present:  SK34-CM6YPX-02 .. -10
//   missing:  SK34-CM6YPX-01 · -11 · -12 · -13 · -14
//
// Upload is a manual button. Nobody who gave up, or whose app died, ever
// presses it — **the seats most worth reading are the ones structurally most
// likely to be missing.** So absence is the signal here, exactly as it is on
// the instructor board (spec §4 rule 1: every roster row is always rendered).
// That is why the listing endpoint diffs against the KV roster rather than
// reporting only what it found.
//
// Deadline is real: R2 retention is 90 days, so the 2026-08-22 objects vanish
// around 2026-11-20 (docs/plan/dag.yaml task I).
//
// ---------------------------------------------------------------------------
// THE ROSTER IS CUMULATIVE. This was found by running the diff against
// production, not by reading the code, and it is the one thing that would have
// made this endpoint useless in practice:
//
//   cohort:sk-biopharm-2026-a:roster  ->  340 handles (2026-09-03)
//
// `setRoster`/roster-append never scopes to a class. One cohort id accumulates
// every token batch ever minted for it — nine SK34 batches, six SK56 batches,
// a dozen `*-verify` probes, and ten 보아치과 handles that predate the split.
// Diffing one class day against all of it names 317 seats as "missing", which
// is noise, and noise is how a signal endpoint gets ignored.
//
// The class IS identifiable, though: handles are minted per batch as
// `<TRACK><BATCH>-<NN>`, so `?seat_prefix=SK34-CM6YPX-` selects exactly one
// class. The filter is a plain string prefix — this module deliberately does
// NOT parse the handle scheme, because nothing else in the codebase does and a
// parser here would be one more guess about a format it does not own.
// `roster_scope` in the response always says which scope was applied, so an
// unscoped call reports its own noisiness instead of quietly being wrong.
//
// ---------------------------------------------------------------------------
// Key layout — assembled by the SERVER on the write side, never by the client:
//
//   studio-logs/<cohort>/<seat>/<day>/<sessionId>/<filename>
//
// <cohort>/<seat> come from the verified token payload (c/u), so a seat cannot
// forge another seat's prefix. `parseLogKey` below is the only reader of that
// layout; chalk/test/logs-read-path.test.mjs pins it against the write path's
// own `uploadObjectKey`, so a change on either side fails the build.
//
// ---------------------------------------------------------------------------
// ACCESS CONTROL — the decision this file had to make, and why.
//
// `events.jsonl` contains participant question text VERBATIM
// (docs/session-log-consent.ko.md). That makes this the one surface in the
// whole plan that legitimately touches prompt text — spec §4 ("zero prompt
// text is what makes this shippable") holds for the board, and this endpoint
// is the deliberate, narrow exception, not a loophole in it. The 2026-08-22
// cohort is a MINORS cohort; the bytes exist lawfully only because a guardian
// consent assertion was recorded before the class
// (`analytics.child_upload_consent` on the sk-biopharm profiles). None of that
// makes the text safe to hand to whoever holds an instructor token.
//
// So the two capabilities get two different gates, because they carry two
// different risks:
//
//   LISTING (arrival check + roster diff)  — instructor issuer, cohort-scoped,
//     the SAME gate as GET /admin/cohorts/:id/state, OR an operator. It emits
//     seat ids, counts, timestamps and byte totals. No file is ever opened; a
//     byte count is not a quotation. An instructor chasing the five seats that
//     did not upload needs exactly this and nothing more.
//
//   RETRIEVAL (fetch a session file)       — OPERATOR ONLY. Never reachable
//     with an instructor issuer token, no matter how it is scoped. The
//     issuer-token path is the metadata path (spec §4, products.yaml `chalk`);
//     verbatim child speech is not metadata.
//
// "Operator" is enforced as, in order:
//   1. Cloudflare Access (`cf-access-authenticated-user-email`) — the
//      production path, same mechanism the Service's /admin/* prefix uses.
//   2. `x-hps-operator-secret` matching HPS_LOGS_OPERATOR_SECRET — the
//      break-glass / local path.
//   3. Otherwise 503. FAIL CLOSED: an unconfigured deployment cannot retrieve.
//
// Two deliberate choices inside that:
//
//   • A DEDICATED secret, not the Service's HPS_ADMIN_PASSWORD. The admin
//     password is broadly held — it sits in .dev.vars, in operator scripts and
//     in the hype-session skill's path, and it is the same value in production.
//     Reusing it would mean everyone who can open a class can also read a
//     child's words. Granting log retrieval has to be a separate, explicit act.
//   • A DISTINCT header, not `Authorization: Bearer`. The Bearer slot on this
//     worker already means "instructor issuer token". Putting a shared operator
//     secret in the same slot invites a handler that accidentally accepts one
//     where it meant the other. Different authority, different header.
//
// Chalk was built with no admin credential on purpose (chalk/src/index.ts,
// products.yaml `chalk`) — this is the one considered exception, and it buys a
// narrower credential than the one it declined to import.
//
// Retrieval additionally re-checks the cohort's upload opt-in
// (`analytics.upload_session_logs === true`), mirroring the write gate. If a
// cohort's consent basis is withdrawn by flipping that flag, the bytes already
// in R2 stop being readable through this surface too — otherwise the opt-in
// would be a one-way door that only ever gated collection, never use.
//
// ---------------------------------------------------------------------------
// DELETION IS OUT OF SCOPE (dag.yaml task I, explicitly). This module contains
// no `.put`, no `.delete`, and never writes. chalk/test/logs-read-path.test.mjs
// greps this file for those calls so "read-only" is an asserted property of the
// source, not a claim in a comment. R2 bindings have no read-only mode in
// wrangler, so the guarantee has to live here.

import { Hono } from "hono";
import type { Context } from "hono";
import type { ChalkEnv } from "../env.ts";
import { authorizeIssuerForCohort, getRoster, listProfiles } from "../shared.ts";

export const logsAdmin = new Hono<{ Bindings: ChalkEnv; Variables: { requestId: string } }>();

/** Root prefix of the upload layout. Everything this module touches lives under it. */
export const LOGS_ROOT = "studio-logs";

/**
 * Filenames the write path accepts, and therefore the only ones that can exist
 * under a session directory. Kept as its own list rather than imported from
 * worker/src/routes/logs.ts because that module imports hono, and
 * chalk/src/shared.ts is deliberately framework-free (two workers, two hono
 * instances). The drift lock lives in the test, which may import both.
 */
export const READABLE_FILENAMES = ["session.meta.json", "events.jsonl", "manifest.json"] as const;

/** Presence of manifest.json is the client's own "this session is complete" claim. */
export const COMPLETION_MARKER = "manifest.json";

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// Seat handles and session ids are single path segments. Anything with a slash,
// a dot-segment or a control character never reaches R2.
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// `?seat_prefix=` — a plain prefix over seat handles, not a parse of them.
const SEAT_PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// R2 list() returns at most 1000 keys per page. A cohort day is ~3 files ×
// ~15 seats; the cap exists so a pathological prefix cannot spin the worker.
const MAX_LIST_PAGES = 20;

export interface LogObject {
  key: string;
  size: number;
  uploaded: string; // ISO8601
}

export interface ParsedLogKey {
  cohort: string;
  seat: string;
  day: string;
  sessionId: string;
  filename: string;
}

/**
 * Build a listing prefix. Mirrors worker/src/routes/logs.ts `uploadObjectKey`;
 * the test asserts the two agree on a full key.
 */
export function logsPrefix(cohort: string, seat?: string, day?: string): string {
  let p = `${LOGS_ROOT}/${cohort}/`;
  if (seat) {
    p += `${seat}/`;
    if (day) p += `${day}/`;
  }
  return p;
}

/** Full object key for one uploaded file. Same shape the write path produced. */
export function logObjectKey(
  cohort: string,
  seat: string,
  day: string,
  sessionId: string,
  filename: string,
): string {
  return `${LOGS_ROOT}/${cohort}/${seat}/${day}/${sessionId}/${filename}`;
}

/**
 * Parse a key back into its parts. Returns null for anything that is not the
 * documented five-segment layout — a stray object under the prefix must not be
 * able to invent a seat. Pure; the arrival summary is built entirely from this.
 */
export function parseLogKey(key: string): ParsedLogKey | null {
  const parts = key.split("/");
  if (parts.length !== 6) return null;
  const [root, cohort, seat, day, sessionId, filename] = parts as [
    string, string, string, string, string, string,
  ];
  if (root !== LOGS_ROOT) return null;
  if (!SEGMENT_RE.test(cohort) || !SEGMENT_RE.test(seat) || !SEGMENT_RE.test(sessionId)) return null;
  if (!DAY_RE.test(day)) return null;
  if (!(READABLE_FILENAMES as readonly string[]).includes(filename)) return null;
  return { cohort, seat, day, sessionId, filename };
}

export interface SessionSummary {
  session_id: string;
  day: string;
  files: number;
  bytes: number;
  /** manifest.json present — the uploader's own completeness claim, unverified. */
  complete: boolean;
  first_upload: string;
  last_upload: string;
}

export interface SeatSummary {
  seat: string;
  /** false when this seat uploaded but is not on the cohort roster. */
  on_roster: boolean;
  sessions: number;
  complete_sessions: number;
  files: number;
  bytes: number;
  first_upload: string;
  last_upload: string;
  days: string[];
}

export interface ArrivalSummary {
  seats: SeatSummary[];
  /** Roster rows with ZERO uploaded objects. This is the point of the endpoint. */
  missing_seats: string[];
  /** Uploaded seats absent from the roster (stale roster, or a seat renamed). */
  unknown_seats: string[];
  roster_size: number;
  uploaded_seats: number;
  total_files: number;
  total_bytes: number;
}

/**
 * Fold a flat object listing plus a roster into the arrival answer.
 *
 * Pure over rows, so the positive control (2026-08-22 must name exactly -01,
 * -11, -12, -13, -14) can be replayed in milliseconds without R2, per
 * .claude/rules/verification.md rule 2. `roster` may be null — a cohort with
 * no roster still lists what arrived, and simply names nothing as missing.
 */
export function summarizeArrival(objects: LogObject[], roster: string[] | null): ArrivalSummary {
  const bySeat = new Map<string, { files: number; bytes: number; first: string; last: string; sessions: Map<string, { complete: boolean }>; days: Set<string> }>();
  let total_files = 0;
  let total_bytes = 0;

  for (const o of objects) {
    const p = parseLogKey(o.key);
    if (!p) continue; // stray object under the prefix — never invents a seat
    total_files += 1;
    total_bytes += o.size;
    let s = bySeat.get(p.seat);
    if (!s) {
      s = { files: 0, bytes: 0, first: o.uploaded, last: o.uploaded, sessions: new Map(), days: new Set() };
      bySeat.set(p.seat, s);
    }
    s.files += 1;
    s.bytes += o.size;
    if (o.uploaded < s.first) s.first = o.uploaded;
    if (o.uploaded > s.last) s.last = o.uploaded;
    s.days.add(p.day);
    const sess = s.sessions.get(p.sessionId) ?? { complete: false };
    if (p.filename === COMPLETION_MARKER) sess.complete = true;
    s.sessions.set(p.sessionId, sess);
  }

  const rosterSet = new Set(roster ?? []);
  const seats: SeatSummary[] = [...bySeat.entries()]
    .map(([seat, s]) => ({
      seat,
      on_roster: rosterSet.size === 0 ? true : rosterSet.has(seat),
      sessions: s.sessions.size,
      complete_sessions: [...s.sessions.values()].filter((x) => x.complete).length,
      files: s.files,
      bytes: s.bytes,
      first_upload: s.first,
      last_upload: s.last,
      days: [...s.days].sort(),
    }))
    .sort((a, b) => (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0));

  const missing_seats = (roster ?? []).filter((u) => !bySeat.has(u)).sort();
  const unknown_seats = roster
    ? [...bySeat.keys()].filter((u) => !rosterSet.has(u)).sort()
    : [];

  return {
    seats,
    missing_seats,
    unknown_seats,
    roster_size: roster?.length ?? 0,
    uploaded_seats: bySeat.size,
    total_files,
    total_bytes,
  };
}

/** Per-session rows for one seat — the ids the retrieval endpoint needs. */
export function summarizeSeatSessions(objects: LogObject[]): SessionSummary[] {
  const bySession = new Map<string, { day: string; files: number; bytes: number; complete: boolean; first: string; last: string }>();
  for (const o of objects) {
    const p = parseLogKey(o.key);
    if (!p) continue;
    const k = `${p.day}/${p.sessionId}`;
    let s = bySession.get(k);
    if (!s) {
      s = { day: p.day, files: 0, bytes: 0, complete: false, first: o.uploaded, last: o.uploaded };
      bySession.set(k, s);
    }
    s.files += 1;
    s.bytes += o.size;
    if (p.filename === COMPLETION_MARKER) s.complete = true;
    if (o.uploaded < s.first) s.first = o.uploaded;
    if (o.uploaded > s.last) s.last = o.uploaded;
  }
  return [...bySession.entries()]
    .map(([k, s]) => ({
      session_id: k.slice(k.indexOf("/") + 1),
      day: s.day,
      files: s.files,
      bytes: s.bytes,
      complete: s.complete,
      first_upload: s.first,
      last_upload: s.last,
    }))
    .sort((a, b) => (a.day + a.session_id < b.day + b.session_id ? -1 : 1));
}

/** Does this cohort carry the server-side upload opt-in the write path required? */
export function cohortUploadOptIn(cohortId: string): boolean {
  const profiles = listProfiles().filter((p) => p.session.cohort_id === cohortId);
  if (profiles.length === 0) return false; // unknown cohort → fail closed
  return profiles.every((p) => p.analytics.upload_session_logs === true);
}

// ---------------------------------------------------------------------------
// R2 access — LIST and GET only. No put, no delete, ever (see header).

async function listAll(bucket: R2Bucket, prefix: string): Promise<{ objects: LogObject[]; truncated: boolean }> {
  const out: LogObject[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of res.objects) {
      out.push({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() });
    }
    if (!res.truncated) return { objects: out, truncated: false };
    cursor = res.cursor;
  }
  return { objects: out, truncated: true };
}

// ---------------------------------------------------------------------------
// Gates

type Ctx = Context<{ Bindings: ChalkEnv; Variables: { requestId: string } }>;

/** Constant-time string compare — the operator secret is a shared secret. */
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type OperatorVerdict =
  | { ok: true; who: string }
  | { ok: false; status: 401 | 503; message: string; code: string };

/**
 * Operator gate for RETRIEVAL. Cloudflare Access first, dedicated secret
 * second, 503 otherwise. An instructor issuer token is NOT an operator and is
 * never consulted here — see the header for why.
 */
export function operatorVerdict(
  headers: { access?: string; secret?: string },
  configuredSecret: string | undefined,
): OperatorVerdict {
  const email = headers.access?.trim();
  if (email) return { ok: true, who: email };

  const configured = configuredSecret?.trim();
  if (!configured || configured.length < 16) {
    return {
      ok: false,
      status: 503,
      code: "retrieval_not_configured",
      message:
        "session-log retrieval is not configured on this deployment — it requires Cloudflare Access or HPS_LOGS_OPERATOR_SECRET (>=16 chars)",
    };
  }
  const presented = headers.secret?.trim();
  if (presented && secretEquals(presented, configured)) {
    return { ok: true, who: "operator-secret" };
  }
  return {
    ok: false,
    status: 401,
    code: "operator_required",
    message:
      "session-log retrieval is operator-only (Cloudflare Access, or x-hps-operator-secret). An instructor token is never sufficient — this path returns participant question text verbatim.",
  };
}

function isOperator(c: Ctx): boolean {
  return operatorVerdict(
    {
      access: c.req.header("cf-access-authenticated-user-email"),
      secret: c.req.header("x-hps-operator-secret"),
    },
    c.env.HPS_LOGS_OPERATOR_SECRET,
  ).ok;
}

/**
 * Gate for the LISTING endpoints: cohort-scoped instructor issuer, or an
 * operator. Metadata only — seat ids, counts, timestamps, bytes.
 */
async function authorizeListing(c: Ctx, cohortId: string): Promise<Response | null> {
  if (isOperator(c)) return null;
  const authz = await authorizeIssuerForCohort(c, cohortId);
  if (authz instanceof Response) return authz;
  if (authz === null) {
    return c.json({ error: "instructor issuer token required (Authorization: Bearer …)" }, 401);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Routes

/**
 * GET /admin/cohorts/:id/logs[?day=YYYY-MM-DD]
 *
 * Arrival check + roster diff in one answer, because the diff is nothing but
 * the two things this handler already holds. Returns 200 with empty lists for a
 * cohort that never uploaded — absence is data, not an error (dag.yaml task I
 * negative control).
 */
logsAdmin.get("/cohorts/:id/logs", async (c) => {
  const cohortId = c.req.param("id");
  if (!SEGMENT_RE.test(cohortId)) return c.json({ error: "invalid cohort id" }, 400);
  const denied = await authorizeListing(c, cohortId);
  if (denied) return denied;

  const day = c.req.query("day");
  if (day !== undefined && !DAY_RE.test(day)) {
    return c.json({ error: "day must be YYYY-MM-DD" }, 400);
  }
  // Scope the roster to one minted batch — see the header. Without it the diff
  // is against every handle the cohort ever held.
  const seatPrefix = c.req.query("seat_prefix");
  if (seatPrefix !== undefined && !SEAT_PREFIX_RE.test(seatPrefix)) {
    return c.json({ error: "seat_prefix must be 1-128 chars of [A-Za-z0-9._-]" }, 400);
  }

  const roster = await getRoster(c.env.HPS_KV, cohortId);
  const cohortRoster = roster?.users ?? null;
  const scopedRoster = cohortRoster && seatPrefix
    ? cohortRoster.filter((u) => u.startsWith(seatPrefix))
    : cohortRoster;

  const { objects, truncated } = await listAll(c.env.HPS_TRACES, logsPrefix(cohortId));
  const filtered = objects.filter((o) => {
    const p = parseLogKey(o.key);
    if (p === null) return false;
    if (day && p.day !== day) return false;
    if (seatPrefix && !p.seat.startsWith(seatPrefix)) return false;
    return true;
  });

  const summary = summarizeArrival(filtered, scopedRoster);
  return c.json({
    cohort: cohortId,
    now: new Date().toISOString(),
    day: day ?? null,
    upload_opt_in: cohortUploadOptIn(cohortId),
    truncated,
    // Always state the scope the diff was taken under. An unscoped call is
    // legal and reports every roster row as missing; the caller must be able
    // to see that from the answer rather than infer it.
    roster_scope: {
      seat_prefix: seatPrefix ?? null,
      cohort_roster_size: cohortRoster?.length ?? 0,
      scoped_roster_size: scopedRoster?.length ?? 0,
    },
    ...summary,
  });
});

/**
 * GET /admin/cohorts/:id/logs/:seat — per-session rows for one seat. Metadata
 * only; this is where the operator gets the session_id that retrieval needs.
 */
logsAdmin.get("/cohorts/:id/logs/:seat", async (c) => {
  const cohortId = c.req.param("id");
  const seat = c.req.param("seat");
  if (!SEGMENT_RE.test(cohortId) || !SEGMENT_RE.test(seat)) {
    return c.json({ error: "invalid cohort id or seat" }, 400);
  }
  const denied = await authorizeListing(c, cohortId);
  if (denied) return denied;

  const { objects, truncated } = await listAll(c.env.HPS_TRACES, logsPrefix(cohortId, seat));
  return c.json({
    cohort: cohortId,
    seat,
    now: new Date().toISOString(),
    truncated,
    sessions: summarizeSeatSessions(objects),
  });
});

/**
 * GET /admin/cohorts/:id/logs/:seat/:day/:session/:filename — OPERATOR ONLY.
 *
 * The one endpoint in Chalk that returns participant text. Every call is
 * logged with the operator identity and the exact key, because a read of a
 * child's words should leave a trace even when it is authorized.
 */
logsAdmin.get("/cohorts/:id/logs/:seat/:day/:session/:filename", async (c) => {
  const cohortId = c.req.param("id");
  const seat = c.req.param("seat");
  const day = c.req.param("day");
  const sessionId = c.req.param("session");
  const filename = c.req.param("filename");
  const rid = c.get("requestId") ?? "no-request-id";

  const verdict = operatorVerdict(
    {
      access: c.req.header("cf-access-authenticated-user-email"),
      secret: c.req.header("x-hps-operator-secret"),
    },
    c.env.HPS_LOGS_OPERATOR_SECRET,
  );
  if (!verdict.ok) {
    return c.json({ error: { type: "auth", code: verdict.code, message: verdict.message, request_id: rid } }, verdict.status);
  }

  if (!SEGMENT_RE.test(cohortId) || !SEGMENT_RE.test(seat) || !SEGMENT_RE.test(sessionId)) {
    return c.json({ error: "invalid cohort id, seat or session id" }, 400);
  }
  if (!DAY_RE.test(day)) return c.json({ error: "day must be YYYY-MM-DD" }, 400);
  if (!(READABLE_FILENAMES as readonly string[]).includes(filename)) {
    return c.json({ error: `filename not readable: ${filename}`, readable: READABLE_FILENAMES }, 400);
  }

  // Consent basis is re-checked on READ, not only on write. Flipping the
  // cohort's opt-in off closes this door for bytes already collected.
  if (!cohortUploadOptIn(cohortId)) {
    return c.json(
      {
        error: {
          type: "policy",
          code: "cohort_not_opted_in",
          message: `cohort ${cohortId} does not carry analytics.upload_session_logs — session logs are not readable`,
          request_id: rid,
        },
      },
      403,
    );
  }

  const key = logObjectKey(cohortId, seat, day, sessionId, filename);
  const obj = await c.env.HPS_TRACES.get(key);
  if (!obj) return c.json({ error: "not found", key, request_id: rid }, 404);

  console.log(
    `[${rid}] studio-logs retrieval by=${verdict.who} key=${key} bytes=${obj.size}`,
  );

  return new Response(obj.body, {
    headers: {
      "content-type": filename.endsWith(".jsonl")
        ? "application/x-ndjson; charset=utf-8"
        : "application/json; charset=utf-8",
      "content-length": String(obj.size),
      "cache-control": "no-store",
      "x-hps-log-key": key,
      "x-request-id": rid,
    },
  });
});
