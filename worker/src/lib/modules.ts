// Module distribution — curriculum out of the binary (dag task H; spec
// docs/plan/vessel-and-modules.md §1 · §2 · §5).
//
// Why this exists (it is not release hygiene): compiled-in curriculum shares a
// review, a deploy and a rollback unit with the gateway. Whichever side has
// friction changes less — philosophy §18 names exactly that failure. And §11's
// research loop needs evidence attributable to *which curriculum produced it*;
// the curriculum version IS the experimental condition. Today it has no name.
//
// ─── What moved, what stayed (the §1 rule, applied honestly) ─────────────────
//
//  MOVED  — the cohort system prompt (`prompts/<cohort>.md`). Pure curriculum
//           text; the only thing whose author is a curriculum designer and
//           whose change should never require a code review.
//
//  STAYED — `prompts/_*.md` (preview-env, gallery-publish, web-search
//           discipline, browser-control ×2, runtime-degraded notice). Data in
//           form, but each one describes an invariant of CODE that ships on
//           another train: the iframe sandbox the app enforces, the tool names
//           browser-tools.ts defines, the SDK MCP tool set. They must share a
//           rollback unit with the code they describe, so they stay compiled.
//         — the Profile object (model, sdk_tools, minor_cohort, analytics …).
//           These are POLICY, and the cohort harness (`scripts/cohort-harness/
//           validate.py`, `child_sdk_write` etc.) gates them at review time.
//           Runtime-loading them would route around a safety gate this repo
//           relies on. UX text inside it (welcome, chips) is data and can follow
//           later as a second module kind — the envelope below already allows
//           it — but it does not need to move to make the loop close.
//         — skills/*.md and skeletons/*.html. Data, and Module-layer by the
//           rule; deferred because they are shared across cohorts (a skill is
//           not owned by one profile) and the pin model here is per-profile.
//           Named here so nobody mistakes "not moved" for "not data".
//
//  ONE HARNESS RULE LIVES IN THE TEXT (attempt 2). The inventory above was one
//  field too narrow: `child_missing_url_ban` asserts on the PROMPT, not on a
//  profile key, so it left the binary with the prose. The serve-side validator
//  now derives that requirement from the harness's own rules.yaml
//  (lib/harness-rules.ts) and refuses a child-cohort module that lacks the
//  phrase exactly like a checksum mismatch. The publisher runs the same check
//  for fast feedback, but the WORKER check is the guarantee — anyone with
//  wrangler can write the KV key directly.
//
// ─── Storage: KV, and why (decided independently of liveness.ts) ─────────────
//
//  The access pattern is: read on EVERY chat turn, write a few times per
//  cohort per week. A KV `get` is served from the PoP edge cache; R2 is an
//  origin round-trip per read with no edge cache unless we build one. The
//  worker memoises per isolate anyway (below), so either store would work —
//  KV wins on the cold-isolate path and on tooling (`wrangler kv key put` is
//  the whole distribution mechanism; no upload route, no new binding).
//
//  KV is eventually consistent (~60 s across PoPs). That is harmless here
//  because VERSIONS ARE IMMUTABLE: a version key is written once and never
//  changed, so a stale read of a version returns correct bytes. The only
//  mutable key is the pin, and a stale pin means "the previous curriculum for
//  up to a minute more", which is the semantics a rollback needs anyway.
//
//  Keys:
//    module:<kind>:<profile_id>:v:<version>   → ModuleDoc     (immutable)
//    module:<kind>:<profile_id>:pin           → ModulePin     (the switch)
//
//  Versioning: `m<YYYY.MM.DD>-<n>` — the spec's m* prefix, sibling of the
//  worker's w* tag. Publishing a version does NOT activate it; pinning does.
//  Rollback = pin the previous version (the pin records `previous` so the
//  worker can do that on its own when the current pin is unservable).
//
//  No pin → the compiled-in text, versioned as `compiled:<sha256[:12]>` of the
//  exact bytes, so a turn is attributable even before anyone has published.
//
// ─── Cache strategy (prompt caching) ─────────────────────────────────────────
//
//  The cached prefix is `buildCachedPrefix()` in translate.ts; its first
//  section is `profile.system_prompt`. Swapping a module version changes those
//  bytes, so the FIRST request after a swap misses (cache_creation > 0) and
//  every request after that hits (cache_read > 0) — that is the DAG's positive
//  control, and it is measured, not argued. Live run 2026-09-04 against
//  api.anthropic.com, claude-sonnet-4-6 (the cohort's pin), sk-biopharm 3-4,
//  "sdk" runtime, blocks built by buildAnthropicSystemBlocks() on a
//  resolveProfile() result — exactly the worker's bytes:
//
//      R1 compiled            cache_creation=14668  cache_read=0
//      R2 compiled again      cache_creation=0      cache_read=14668
//      R3 module m…-1 (swap)  cache_creation=14699  cache_read=0      ← the one expected miss
//      R4 module m…-1 again   cache_creation=0      cache_read=14699  ← positive control
//
//  One honest consequence of "system_prompt is section 1 of the prefix": a
//  curriculum swap re-caches the WHOLE prefix (14.7k tokens, not the 30 that
//  changed), because everything after it shifts. That is one ~US$0.05 miss per
//  swap per cohort, not a per-isolate or per-student cost — acceptable, and
//  reordering the prefix to put stable contracts first would change prompt
//  semantics for a fraction of a cent. Left as is, on purpose.
//
//  What would break caching SILENTLY, and what prevents it here:
//   1. A version stamp inside the prefix. The version goes on the turn RECORD
//      (usage_log analytics blob, x-hps-module header), never into the prompt.
//   2. Prefix flapping on a transient KV fault. The isolate keeps the LAST
//      SERVED module (`lastGood`) and serves it again on ANY transport failure
//      — pin read or doc read — instead of dropping to the compiled text for
//      one request. (Attempt 1 only covered the pin read; a warm pin with a
//      cold doc memo fell straight through to compiled and raised the bad-
//      publish alarm for a network fault.) A cold isolate with nothing served
//      yet has no last-good and serves compiled — one PoP, until KV recovers.
//   3. Cross-isolate divergence on fallback: if isolate A decides "bad module
//      → previous" and isolate B decides "bad module → compiled", the cohort
//      has two prefixes. The fallback chain is deterministic and driven by
//      data in the pin record (`previous`), so every isolate lands on the same
//      bytes.
//
// ─── Vessel contracts (§5) ───────────────────────────────────────────────────
//
//  Open on absence   — no pin → compiled text, no log noise (normal state).
//  Closed on error   — a malformed version disables only ITSELF: the profile
//                      falls to `previous`, then to compiled. Nothing else in
//                      the profile is affected; the class keeps running.
//  Ignorant of content — the worker validates the ENVELOPE and, for kind
//                      "curriculum", that `system_prompt` is a non-empty
//                      string in a sane band that satisfies the harness's
//                      text-level rules for this cohort. It does not read the
//                      prose. Unknown fields are ignored (an older worker must
//                      accept a newer publisher's doc).
//  Announces loss    — EVERY degraded state carries a `fallback` on the turn
//                      record (usage blob[6] + x-hps-module-fallback), writes a
//                      `module_fallback` Analytics datapoint with its CAUSE
//                      (missing · malformed · bad_pin · transport), and logs
//                      once per pin-refresh window. Bad pins and KV outages are
//                      as loud as bad modules; a transport fault says so, so
//                      nobody hunts a bad publish that does not exist.
//                      Never an empty prompt: the compiled text is the floor.
//
// The second module kind, "session-design" (the Chalk contract), uses the same
// envelope and the same pin/version keys; only the per-kind content validator
// differs. This worker consumes "curriculum" only.

import { getProfile, type Profile } from "../profiles";
import {
  curriculumRequirementsFor,
  checkCurriculumRequirements,
  type CurriculumRequirements,
} from "./harness-rules";

export const MODULE_FORMAT = "hps-module/1";
export type ModuleKind = "curriculum" | "session-design";
export const MODULE_KINDS: readonly ModuleKind[] = ["curriculum", "session-design"];

/** `m2026.09.04-1` — the spec's m* prefix; `-n` disambiguates within a day. */
export const MODULE_VERSION_RE = /^m\d{4}\.\d{2}\.\d{2}-\d{1,4}$/;

/**
 * Sanity band for a curriculum prompt. The floor catches "someone published an
 * empty file"; the ceiling catches "someone published the wrong file". A prompt
 * truncated in transit is caught by the checksum, not by the band.
 */
export const CURRICULUM_MIN_CHARS = 500;
export const CURRICULUM_MAX_CHARS = 200_000;

/** How long an isolate trusts its copy of the pin before re-reading KV. */
export const PIN_MEMO_MS = 30_000;

export interface ModuleDoc {
  format: typeof MODULE_FORMAT;
  kind: ModuleKind;
  profile_id: string;
  version: string;
  /** lowercase hex sha-256 of JSON.stringify(content) — integrity, not auth. */
  sha256: string;
  published_at: string;
  notes?: string;
  content: Record<string, unknown>;
}

export interface CurriculumContent {
  system_prompt: string;
}

export interface ModulePin {
  version: string;
  /** The version pinned before this one — the worker's own rollback target. */
  previous?: string | null;
  pinned_at: string;
  by?: string;
}

/**
 * Why a turn is not running on its pin.
 *   missing    — the pinned version has no document at its key
 *   malformed  — the document exists and the worker refused it (envelope,
 *                checksum, band, or a harness text rule)
 *   bad_pin    — the pin record itself is not a version
 *   transport  — KV could not be read; the bytes served are the last known
 *                good (or compiled on a cold isolate). NOT a bad publish.
 */
export type FallbackCause = "missing" | "malformed" | "bad_pin" | "transport";

export interface ModuleFallback {
  /** The pin that could not be honoured (a version, or the raw bad pin value). */
  pinned: string;
  reason: string;
  cause: FallbackCause;
}

export interface ModuleResolution {
  kind: "curriculum";
  /** `m2026.09.04-1` when served from KV; `compiled:<12 hex>` otherwise. */
  version: string;
  source: "kv" | "compiled";
  /** Present in every degraded state. Loud on purpose. */
  fallback?: ModuleFallback;
}

export interface ResolvedProfile {
  profile: Profile;
  module: ModuleResolution;
}

export const moduleDocKey = (kind: ModuleKind, profileId: string, version: string) =>
  `module:${kind}:${profileId}:v:${version}`;
export const modulePinKey = (kind: ModuleKind, profileId: string) =>
  `module:${kind}:${profileId}:pin`;
export const MODULE_KEY_PREFIX = "module:";

// ─── checksum ────────────────────────────────────────────────────────────────

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The checksum the envelope carries: over the compact JSON of `content`. */
export function contentChecksumInput(content: unknown): string {
  return JSON.stringify(content);
}

// ─── validation (the negative control lives here) ────────────────────────────

export type ModuleValidation =
  | { ok: true; doc: ModuleDoc }
  | { ok: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function isModuleVersion(v: unknown): v is string {
  return typeof v === "string" && MODULE_VERSION_RE.test(v);
}

export interface ValidateExpect {
  kind: ModuleKind;
  profileId: string;
  version?: string;
  /**
   * Text-level rules the harness would apply to this cohort's prompt
   * (lib/harness-rules.ts curriculumRequirementsFor). Omitted = none, which is
   * only correct for a non-child cohort; callers that have the profile MUST
   * pass it. resolveProfile and the publisher both do.
   */
  requirements?: CurriculumRequirements;
}

/**
 * Validate a raw KV value as a module document for (kind, profileId).
 *
 * Envelope first, then the per-kind content rule. Every rejection names the
 * field, because the person reading the log is the one who just published and
 * needs to know what to fix — not "invalid module".
 */
export async function validateModuleDoc(raw: unknown, expect: ValidateExpect): Promise<ModuleValidation> {
  const bad = (reason: string): ModuleValidation => ({ ok: false, reason });
  if (!isRecord(raw)) return bad("document is not a JSON object");
  if (raw.format !== MODULE_FORMAT) {
    return bad(`format must be ${JSON.stringify(MODULE_FORMAT)}, got ${JSON.stringify(raw.format)}`);
  }
  if (raw.kind !== expect.kind) {
    return bad(`kind must be ${JSON.stringify(expect.kind)}, got ${JSON.stringify(raw.kind)}`);
  }
  if (raw.profile_id !== expect.profileId) {
    return bad(`profile_id must be ${JSON.stringify(expect.profileId)}, got ${JSON.stringify(raw.profile_id)}`);
  }
  if (!isModuleVersion(raw.version)) {
    return bad(`version must match ${MODULE_VERSION_RE}, got ${JSON.stringify(raw.version)}`);
  }
  if (expect.version !== undefined && raw.version !== expect.version) {
    return bad(`version ${JSON.stringify(raw.version)} does not match its key ${JSON.stringify(expect.version)}`);
  }
  if (typeof raw.published_at !== "string" || !Number.isFinite(Date.parse(raw.published_at))) {
    return bad("published_at must be an ISO-8601 string");
  }
  if (!isRecord(raw.content)) return bad("content must be an object");
  if (typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) {
    return bad("sha256 must be 64 lowercase hex chars");
  }
  const want = await sha256Hex(contentChecksumInput(raw.content));
  if (want !== raw.sha256) {
    return bad(`sha256 mismatch — content is not what was published (expected ${want.slice(0, 12)}…, got ${raw.sha256.slice(0, 12)}…)`);
  }

  if (expect.kind === "curriculum") {
    const sp = raw.content.system_prompt;
    if (typeof sp !== "string") return bad("content.system_prompt must be a string");
    if (sp.trim().length < CURRICULUM_MIN_CHARS) {
      return bad(`content.system_prompt is ${sp.trim().length} chars; floor is ${CURRICULUM_MIN_CHARS}`);
    }
    if (sp.length > CURRICULUM_MAX_CHARS) {
      return bad(`content.system_prompt is ${sp.length} chars; ceiling is ${CURRICULUM_MAX_CHARS}`);
    }
    if (sp.includes("\u0000")) return bad("content.system_prompt contains a NUL byte");
    // The harness rule that lives in the text (attempt 2). Derived from
    // rules.yaml, never hardcoded here.
    if (expect.requirements) {
      const violated = checkCurriculumRequirements(sp, expect.requirements);
      if (violated) return bad(violated);
    }
  }
  // "session-design" has no consumer in this worker yet; envelope-only.

  return { ok: true, doc: raw as unknown as ModuleDoc };
}

export function validatePin(raw: unknown): { ok: true; pin: ModulePin } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "pin is not a JSON object" };
  if (!isModuleVersion(raw.version)) {
    return { ok: false, reason: `pin.version must match ${MODULE_VERSION_RE}, got ${JSON.stringify(raw.version)}` };
  }
  const previous = raw.previous;
  if (previous != null && !isModuleVersion(previous)) {
    return { ok: false, reason: `pin.previous must be a version or null, got ${JSON.stringify(previous)}` };
  }
  return {
    ok: true,
    pin: {
      version: raw.version,
      previous: (previous as string | null | undefined) ?? null,
      pinned_at: typeof raw.pinned_at === "string" ? raw.pinned_at : "",
      by: typeof raw.by === "string" ? raw.by : undefined,
    },
  };
}

/** Build a document the way the publisher does — the ONE way to make one. */
export async function makeModuleDoc(input: {
  kind: ModuleKind;
  profileId: string;
  version: string;
  content: Record<string, unknown>;
  notes?: string;
  publishedAt?: string;
}): Promise<ModuleDoc> {
  return {
    format: MODULE_FORMAT,
    kind: input.kind,
    profile_id: input.profileId,
    version: input.version,
    sha256: await sha256Hex(contentChecksumInput(input.content)),
    published_at: input.publishedAt ?? new Date().toISOString(),
    ...(input.notes ? { notes: input.notes } : {}),
    content: input.content,
  };
}

// ─── isolate memo ────────────────────────────────────────────────────────────
//
// Per-isolate, not per-request. A pin is re-read at most every PIN_MEMO_MS; a
// version doc that validated is kept for the life of the isolate (immutable);
// a version doc that FAILED is remembered for PIN_MEMO_MS so a bad publish is
// not re-fetched on every turn, yet a hot-fix (republish + re-pin) still
// propagates within a minute. A transport failure is never memoised as a
// verdict. `lastGood` is the last module actually served from KV, kept so a
// transport fault serves the same bytes instead of flapping the prefix.

type KvLike = Pick<KVNamespace, "get">;

interface PinMemo {
  /** null = "no pin" was the last observed state. */
  pin: ModulePin | null;
  at: number;
}
type PinRead =
  | { pin: ModulePin | null; transport?: false; badPin?: undefined }
  | { pin: ModulePin | null; transport: true; badPin?: undefined }
  | { pin: null; transport?: false; badPin: { raw: string; reason: string } };

type DocMemo = { ok: true; doc: ModuleDoc } | { ok: false; cause: "missing" | "malformed"; reason: string; at: number };
type DocRead = DocMemo | { ok: false; cause: "transport"; reason: string };

const pinMemo = new Map<string, PinMemo>();
const docMemo = new Map<string, DocMemo>();
const compiledVersionMemo = new Map<string, string>();
const lastGood = new Map<string, ResolvedProfile>();
/** Last fallback we already shouted about, per profile — once per refresh window, not per turn. */
const announced = new Map<string, string>();

export function _resetModuleMemoForTests(): void {
  pinMemo.clear();
  docMemo.clear();
  compiledVersionMemo.clear();
  lastGood.clear();
  announced.clear();
}

const UNPARSEABLE = Symbol("unparseable");

async function kvGetJson(kv: KvLike, key: string): Promise<unknown> {
  // KV returns the parsed value for "json"; the value may also arrive as a
  // string (test doubles, or a value that fails KV's own parse and is handed
  // back raw). Normalise, and let a malformed payload surface as a rejection
  // from the validator rather than a throw here.
  let v: unknown;
  try {
    v = await kv.get(key, "json");
  } catch (err) {
    // KV parses "json" itself and throws on a value that is not JSON. That is
    // a MALFORMED value (memoise + announce), not a transport failure (retry).
    if (err instanceof SyntaxError) return UNPARSEABLE;
    throw err;
  }
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return UNPARSEABLE;
    }
  }
  return v;
}

async function readPin(kv: KvLike, profileId: string, now: number): Promise<PinRead> {
  const key = modulePinKey("curriculum", profileId);
  const memo = pinMemo.get(profileId);
  if (memo && now - memo.at < PIN_MEMO_MS) return { pin: memo.pin };
  let raw: unknown;
  try {
    raw = await kvGetJson(kv, key);
  } catch (err) {
    // Transient KV failure. Keep serving what we last saw (prefix stability
    // matters more than a 30 s-fresh pin) — and say so, upstream, loudly.
    console.warn(`[module] KV read failed for ${key}; serving last observed pin`, err);
    if (memo) {
      pinMemo.set(profileId, { pin: memo.pin, at: now });
      return { pin: memo.pin, transport: true };
    }
    return { pin: null, transport: true };
  }
  if (raw == null) {
    pinMemo.set(profileId, { pin: null, at: now });
    return { pin: null };
  }
  const v = raw === UNPARSEABLE ? { ok: false as const, reason: "pin is not JSON" } : validatePin(raw);
  if (!v.ok) {
    // A bad pin is a bad publish, not "no pin" — it must be as loud as a bad
    // module. Memoise as unpinned so the turn runs on compiled text.
    pinMemo.set(profileId, { pin: null, at: now });
    const rawStr = raw === UNPARSEABLE ? "<not json>" : JSON.stringify(raw).slice(0, 80);
    return { pin: null, badPin: { raw: rawStr, reason: v.reason } };
  }
  pinMemo.set(profileId, { pin: v.pin, at: now });
  return { pin: v.pin };
}

async function readDoc(
  kv: KvLike,
  profileId: string,
  version: string,
  requirements: CurriculumRequirements,
  now: number,
): Promise<DocRead> {
  const key = moduleDocKey("curriculum", profileId, version);
  const memo = docMemo.get(key);
  if (memo && (memo.ok || now - memo.at < PIN_MEMO_MS)) return memo;
  let raw: unknown;
  try {
    raw = await kvGetJson(kv, key);
  } catch (err) {
    console.warn(`[module] KV read failed for ${key}`, err);
    // Never memoise a transport failure as a verdict about the module.
    return { ok: false, cause: "transport", reason: `KV read failed for ${version}` };
  }
  let out: DocMemo;
  if (raw == null) {
    out = { ok: false, cause: "missing", reason: "no document at this key (published? typo in version?)", at: now };
  } else if (raw === UNPARSEABLE) {
    out = { ok: false, cause: "malformed", reason: "document is not JSON", at: now };
  } else {
    const v = await validateModuleDoc(raw, { kind: "curriculum", profileId, version, requirements });
    out = v.ok ? { ok: true, doc: v.doc } : { ok: false, cause: "malformed", reason: v.reason, at: now };
  }
  docMemo.set(key, out);
  return out;
}

export async function compiledVersionFor(profile: Profile): Promise<string> {
  const memo = compiledVersionMemo.get(profile.id);
  if (memo) return memo;
  const v = `compiled:${(await sha256Hex(profile.system_prompt)).slice(0, 12)}`;
  compiledVersionMemo.set(profile.id, v);
  return v;
}

// ─── the resolver ────────────────────────────────────────────────────────────

export interface ModuleEnv {
  HPS_KV: KvLike;
  HPS_ANALYTICS?: Pick<AnalyticsEngineDataset, "writeDataPoint">;
}

function announceFallback(env: ModuleEnv, profileId: string, fb: ModuleFallback, served: string): void {
  // Once per (profile, cause, pinned, served) per isolate — i.e. once per pin
  // refresh window, not once per turn. The per-turn signal is the usage row
  // (blob[5]/[6]) and the x-hps-module(-fallback) headers.
  const sig = `${fb.cause}:${fb.pinned}→${served}:${fb.reason}`;
  if (announced.get(profileId) === sig) return;
  announced.set(profileId, sig);
  const line =
    fb.cause === "transport"
      ? `[module] curriculum for ${profileId}: KV unreachable (${fb.reason}); serving ${served} from isolate memory. ` +
        `This is a TRANSPORT fault, not a bad publish — check KV/Cloudflare status, not the module.`
      : fb.cause === "bad_pin"
        ? `[module] curriculum for ${profileId}: pin record is malformed (${fb.reason}; raw ${fb.pinned}); ` +
          `serving ${served}. Fix: \`npm run module -- pin ${profileId} <version>\` or \`unpin\`.`
        : `[module] curriculum for ${profileId}: pinned ${fb.pinned} is NOT servable (${fb.cause}: ${fb.reason}); ` +
          `serving ${served} instead. Fix: publish a good version and re-pin, or \`npm run module -- pin ${profileId} <version>\`.`;
  console.error(line);
  try {
    env.HPS_ANALYTICS?.writeDataPoint({
      indexes: [profileId],
      // blobs: discriminator, profile, pinned, served, reason, CAUSE
      blobs: ["module_fallback", profileId, fb.pinned, served, fb.reason.slice(0, 200), fb.cause],
      doubles: [1],
    });
  } catch {
    /* analytics is best-effort */
  }
}

/**
 * The compiled profile with its curriculum module applied.
 *
 *   no pin                      → compiled text, version `compiled:<hash>`, silent
 *   pin → good doc              → module text, version = pin
 *   pin → missing/malformed doc → pin.previous if good, else compiled; fallback set
 *   bad pin record              → compiled; fallback cause bad_pin
 *   KV unreachable              → last served module if any, else compiled;
 *                                 fallback cause transport (says so)
 *
 * Every degraded row is announced (console.error once per refresh window +
 * `module_fallback` datapoint) and carried on the turn record. Returns null
 * only when the profile id itself is unknown — module state can never make a
 * known profile disappear (closed on error).
 */
export async function resolveProfile(
  env: ModuleEnv,
  profileId: string,
  now: number = Date.now(),
): Promise<ResolvedProfile | null> {
  const base = getProfile(profileId);
  if (!base) return null;
  const requirements = curriculumRequirementsFor(base);

  const compiled = async (fallback?: ModuleFallback): Promise<ResolvedProfile> => ({
    profile: base,
    module: {
      kind: "curriculum",
      version: await compiledVersionFor(base),
      source: "compiled",
      ...(fallback ? { fallback } : {}),
    },
  });
  const withFallback = (r: ResolvedProfile, fallback: ModuleFallback): ResolvedProfile => ({
    profile: r.profile,
    module: { ...r.module, fallback },
  });
  /** A transport fault: same bytes as last time if we have them, never a flap. */
  const degradedTransport = async (pinned: string, reason: string): Promise<ResolvedProfile> => {
    const fb: ModuleFallback = { pinned, reason, cause: "transport" };
    const prev = lastGood.get(profileId);
    const out = prev ? withFallback(prev, fb) : await compiled(fb);
    announceFallback(env, profileId, fb, out.module.version);
    return out;
  };

  const pinRead = await readPin(env.HPS_KV, profileId, now);
  if (pinRead.badPin) {
    const fb: ModuleFallback = { pinned: pinRead.badPin.raw, reason: pinRead.badPin.reason, cause: "bad_pin" };
    const out = await compiled(fb);
    announceFallback(env, profileId, fb, out.module.version);
    return out;
  }
  const pin = pinRead.pin;
  if (!pin) {
    if (pinRead.transport) return degradedTransport(lastGood.get(profileId)?.module.version ?? "unknown", "pin read failed");
    return compiled();
  }

  const tryVersion = async (version: string) => {
    const d = await readDoc(env.HPS_KV, profileId, version, requirements, now);
    if (!d.ok) return d;
    const content = d.doc.content as unknown as CurriculumContent;
    const resolved: ResolvedProfile = {
      profile: { ...base, system_prompt: content.system_prompt },
      module: { kind: "curriculum", version, source: "kv" },
    };
    return { ok: true as const, resolved };
  };

  const cur = await tryVersion(pin.version);
  if (cur.ok) {
    lastGood.set(profileId, cur.resolved);
    if (pinRead.transport) {
      // The doc was memoised, so the bytes are right — but say the pin read
      // failed, or an outage that outlives the memo goes unseen.
      const fb: ModuleFallback = { pinned: pin.version, reason: "pin read failed; served from isolate memory", cause: "transport" };
      announceFallback(env, profileId, fb, pin.version);
      return withFallback(cur.resolved, fb);
    }
    return cur.resolved;
  }
  if (cur.cause === "transport") return degradedTransport(pin.version, cur.reason);

  // The pinned version is missing or malformed: a bad publish. Deterministic
  // chain — previous (data in the pin), then compiled.
  const fb: ModuleFallback = { pinned: pin.version, reason: cur.reason, cause: cur.cause };
  if (pin.previous && pin.previous !== pin.version) {
    const prev = await tryVersion(pin.previous);
    if (prev.ok) {
      lastGood.set(profileId, prev.resolved);
      announceFallback(env, profileId, fb, pin.previous);
      return withFallback(prev.resolved, fb);
    }
    if (prev.cause === "transport") return degradedTransport(pin.version, `${cur.reason}; previous ${pin.previous}: ${prev.reason}`);
  }
  const out = await compiled(fb);
  announceFallback(env, profileId, fb, out.module.version);
  return out;
}
