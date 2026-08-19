// tests/load — 23-way classroom load harness: configuration + PASS/FAIL thresholds.
//
// Thresholds are CONSTANTS committed BEFORE any run (verification.md rule 1:
// 판정 기준을 세우기 전에 대상을 열어본다 — and once set, do not move them to
// make a run pass). Each one names the observation it came from.

/* ------------------------------------------------------------------ *
 * PASS/FAIL thresholds — frozen 2026-08-19, before the first run.
 * ------------------------------------------------------------------ */
export const THRESHOLDS = {
  // TTFT = time to the first *text* delta the child can see, not first byte.
  // (message_start arrives earlier and shows nothing on screen.)
  ttft_p95_ms: 3_000,

  // Whole turn, request → [DONE].
  turn_p95_ms: 25_000,

  // 보아치과 2026-07-29 measured 211s at p99 — that is the number this
  // gate exists to prevent repeating.
  turn_p99_ms: 60_000,

  // Learner-exposed failures. NOTE: the worker's callAnthropicResilient
  // absorbs transient upstream 429/5xx (#373), so this counts what a child
  // would actually see, NOT upstream 429s. See README "무엇을 못 재는가".
  non_200_rate: 0,

  // cache_read_input_tokens / (input + cache_read + cache_creation).
  // Dental run measured 80–94%.
  cache_read_ratio_min: 0.80,

  // Scale tier ITPM limit is 10,000,000 — gate at 20% of it.
  peak_billable_itpm_max: 2_000_000,
};

/* ------------------------------------------------------------------ *
 * Cohort / profile wiring — read from the live worker, not guessed.
 * ------------------------------------------------------------------ */
export const COHORT_ID = process.env.LOAD_COHORT ?? "sk-biopharm-2026-a";

// Both SK kids profiles declare coach_runtime: "agent-sdk"
// (worker/src/profiles/sk-biopharm-kids-*.ts), so production traffic for
// these cohorts is Anthropic-native POST /v1/messages, NOT the OpenAI-shaped
// /v1/chat/completions proxy path. Default the harness to production truth.
export const PROFILE_GRADE_3_4 = "sk-biopharm-kids-2026-grade-3-4-s1";
export const PROFILE_GRADE_5_6 = "sk-biopharm-kids-2026-grade-5-6-s1";

// Requested classroom split (13 × 5-6학년, 10 × 3-4학년).
// ⚠ A single cohort can only have ONE active session, and chat-gate.ts:159
// rejects any token whose profile != session.profile_id with 403
// session_profile_mismatch. Running both tracks at once against ONE cohort is
// therefore impossible today — see README "23-way 를 돌리기 위해 사람이 할 일".
export const SPLIT = {
  [PROFILE_GRADE_5_6]: 13,
  [PROFILE_GRADE_3_4]: 10,
};

export const WORKER_ORIGIN = process.env.LOAD_WORKER_ORIGIN ?? "https://api.hypeproof-ai.xyz";
export const WORKER_URL = `${WORKER_ORIGIN}/v1`;

// "messages" = Agent SDK gateway (production for these cohorts).
// "chat"     = OpenAI-shaped proxy path (kept so the two runtimes are
//              directly comparable on the same script).
export const LOAD_PATH = process.env.LOAD_PATH ?? "messages";

/* ------------------------------------------------------------------ *
 * Load shape
 * ------------------------------------------------------------------ */
export const RUN = {
  // "burst"   — every worker fires turn 1 at t=0, then drifts on its own
  //             think-time. The instructor's "다들 지금 보내보세요".
  // "barrier" — EVERY turn is synchronized across all workers. Sustained
  //             worst case; Poisson arrival never produces this.
  // "stagger" — seeded random start offset in [0, stagger_ms).
  arrival: process.env.LOAD_ARRIVAL ?? "burst",

  workers: Number(process.env.LOAD_WORKERS ?? 1),
  turns: Number(process.env.LOAD_TURNS ?? 8),

  // Child-speed think time between turns.
  think_min_ms: Number(process.env.LOAD_THINK_MIN_MS ?? 30_000),
  think_max_ms: Number(process.env.LOAD_THINK_MAX_MS ?? 90_000),
  stagger_ms: Number(process.env.LOAD_STAGGER_MS ?? 20_000),

  // Fixed seed → identical guest picks and think-times across runs.
  seed: Number(process.env.LOAD_SEED ?? 20260819),

  // The build turns emit a whole HTML file. clampMaxTokens (translate.ts:514)
  // hard-caps at 16384 regardless of what we send.
  max_tokens: Number(process.env.LOAD_MAX_TOKENS ?? 16_384),

  // Per-turn hard timeout. Dental max was 278s, so a 60s cap would truncate
  // the tail we are specifically trying to measure.
  turn_timeout_ms: Number(process.env.LOAD_TURN_TIMEOUT_MS ?? 300_000),

  // Grant the coach the SDK tools the cohort actually has
  // (sdk_tools: {read, write}). Without them the "바꿔줘" turn is 165 output
  // tokens instead of thousands — measured 2026-08-19. Set LOAD_TOOLS=0 to
  // reproduce the tool-less shape for comparison.
  tools: process.env.LOAD_TOOLS !== "0",

  // A turn ends when the model stops asking for tools; this caps a runaway.
  max_tool_rounds: Number(process.env.LOAD_MAX_TOOL_ROUNDS ?? 6),
};

// Output-token buckets, chosen to line up with the dental analysis
// (2000+ token turns were 21.8% of sk-biopharm turns).
export const OUTPUT_BUCKETS = [0, 200, 500, 1000, 2000, 4000, 8000, 16384];
