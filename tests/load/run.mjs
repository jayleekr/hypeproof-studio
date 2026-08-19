// tests/load/run.mjs — the harness. 23 Node async workers, not 23 LLM agents.
//
// Why not agents: a load generator must be deterministic and must hit a
// barrier on time. An LLM agent is neither, and it would measure its own
// thinking time as if it were the classroom's.
//
// Usage:
//   LOAD_WORKERS=1 node run.mjs          # positive control (1 student)
//   LOAD_WORKERS=23 LOAD_ARRIVAL=burst node run.mjs
//
// See README.md for env vars, thresholds and traps.

import { mkdirSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../rehearsal/helpers/api.mjs";
import { makeRng, randInt } from "./rng.mjs";
import { buildTurns } from "./script.mjs";
import { runTurn } from "./client.mjs";
import { adminPassword, appendRoster, issueToken, probeToken, getCohortState } from "./tokens.mjs";
import { toolDefs, toolResultFor, newWorkspaceState } from "./tools.mjs";
import {
  COHORT_ID, PROFILE_GRADE_3_4, PROFILE_GRADE_5_6, SPLIT,
  WORKER_ORIGIN, WORKER_URL, LOAD_PATH, RUN, THRESHOLDS,
} from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_VARS = process.env.HPS_DEV_VARS
  ?? "/Users/jaylee/CodeWorkspace/hypeproof-studio/worker/.dev.vars";

/** A rendezvous barrier: every worker waits until all N have arrived. */
function makeBarrier(n) {
  let waiting = 0;
  let resolvers = [];
  return function arrive() {
    if (n <= 1) return Promise.resolve();
    waiting++;
    if (waiting >= n) {
      const rs = resolvers;
      resolvers = [];
      waiting = 0;
      for (const r of rs) r();
      return Promise.resolve();
    }
    return new Promise((r) => resolvers.push(r));
  };
}

/**
 * Decide the per-worker profile assignment.
 *
 * ⚠ chat-gate.ts:159 rejects any token whose profile != the cohort's ACTIVE
 * session profile (403 session_profile_mismatch). So the 13/10 split can only
 * be honored when the open session matches. We therefore read the live session
 * and, unless LOAD_FORCE_SPLIT=1, assign every worker the session's profile and
 * say so loudly. Silently running 23 workers that all 403 would look like a
 * product failure (verification.md rule 6: rule out the instrument first).
 */
function planProfiles(workers, sessionProfileId, forceSplit) {
  if (forceSplit) {
    const plan = [];
    for (const [profile, n] of Object.entries(SPLIT)) {
      for (let i = 0; i < n; i++) plan.push(profile);
    }
    return { plan: plan.slice(0, workers), mode: "forced-split" };
  }
  return { plan: Array.from({ length: workers }, () => sessionProfileId), mode: "session-pinned" };
}

async function main() {
  const runId = process.env.LOAD_RUN_ID
    ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-w${RUN.workers}-${RUN.arrival}`;
  const outDir = join(HERE, "runs");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${runId}.jsonl`);
  const out = createWriteStream(outPath, { flags: "a" });
  const write = (obj) => out.write(JSON.stringify(obj) + "\n");

  const pw = adminPassword(DEV_VARS);
  if (!pw) {
    console.error("HPS_ADMIN_PASSWORD not found (env or worker/.dev.vars). Cannot mint tokens.");
    process.exit(2);
  }

  // --- Preflight: read live state. Never assume the session is open. ---
  const state = await getCohortState(WORKER_ORIGIN, pw, COHORT_ID);
  if (state.status !== 200) {
    console.error(`admin state failed: HTTP ${state.status} ${state.text.slice(0, 200)}`);
    process.exit(2);
  }
  const session = state.json?.session ?? null;
  if (!session) {
    console.error(
      `No active session on ${COHORT_ID}. Chat would 403 session_inactive — that is an\n` +
      `operator state, NOT a product bug. Open one first (skills/hype-session or /console).`,
    );
    process.exit(2);
  }

  const forceSplit = process.env.LOAD_FORCE_SPLIT === "1";
  const { plan, mode } = planProfiles(RUN.workers, session.profile_id, forceSplit);
  // Tools are a messages-path concept; the OpenAI proxy path drops client
  // tools in translate(), so asking for them there would be theatre.
  const useTools = RUN.tools && LOAD_PATH === "messages";

  console.log(
    [
      "",
      "=== HypeProof classroom load harness ===",
      `  run_id        = ${runId}`,
      `  worker origin = ${WORKER_ORIGIN}`,
      `  path          = /v1/${LOAD_PATH === "messages" ? "messages" : "chat/completions"}`,
      `  cohort        = ${COHORT_ID}`,
      `  session       = ${session.session_id} (profile ${session.profile_id}, ends ${session.ends_at})`,
      `  admin pw      = present (len ${pw.length})`,
      `  workers       = ${RUN.workers}   arrival = ${RUN.arrival}   turns = ${RUN.turns}`,
      `  profile plan  = ${mode}` + (mode === "session-pinned"
        ? "  (all workers on the session's profile — see README on the 13/10 split)"
        : "  ⚠ LOAD_FORCE_SPLIT=1: non-session profiles WILL 403 session_profile_mismatch"),
      `  think time    = ${RUN.think_min_ms}-${RUN.think_max_ms}ms   seed = ${RUN.seed}`,
      `  max_tokens    = ${RUN.max_tokens} (worker clamps to 16384)`,
      `  sdk tools     = ${useTools ? "Read,Write,Edit (matches cohort sdk_tools)" : "NONE — heavy build turns will be ~25x too cheap"}`,
      `  out           = ${outPath}`,
      "",
    ].join("\n"),
  );

  // --- Roster + tokens ---
  const userIds = Array.from({ length: RUN.workers }, (_, i) => `load-${String(i + 1).padStart(2, "0")}`);
  const appended = await appendRoster(WORKER_ORIGIN, pw, COHORT_ID, userIds);
  if (appended.status !== 200) {
    console.error(`roster append failed: HTTP ${appended.status} ${appended.text.slice(0, 200)}`);
    process.exit(2);
  }
  console.log(`roster: size=${appended.json?.size} added=${JSON.stringify(appended.json?.added ?? [])}`);

  const students = [];
  for (let i = 0; i < RUN.workers; i++) {
    const t = await issueToken(WORKER_ORIGIN, pw, {
      user: userIds[i], cohort: COHORT_ID, profile: plan[i], hours: 12,
    });
    students.push({ ...t, profile: plan[i], index: i });
  }
  console.log(`minted ${students.length} student tokens (12h)`);

  // Independently verify token #0 before burning a run on a bad token
  // (verification.md: "토큰을 의심하기 전에 토큰을 직접 찔러봐라").
  const probe = await probeToken(WORKER_URL, students[0].token);
  if (probe.status !== 200) {
    console.error(`token probe failed: HTTP ${probe.status} ${probe.text.slice(0, 300)}`);
    process.exit(2);
  }
  console.log(
    `token probe: 200 · profile=${probe.json?.profile_id} · coach_runtime=${probe.json?.coach_runtime} ` +
    `· minor_cohort=${probe.json?.minor_cohort}`,
  );
  if (probe.json?.coach_runtime === "agent-sdk" && LOAD_PATH !== "messages") {
    console.warn(
      `⚠ profile serves coach_runtime=agent-sdk but LOAD_PATH=${LOAD_PATH}. You are loading a\n` +
      `  path production does not use for this cohort. Set LOAD_PATH=messages for truth.`,
    );
  }

  write({
    kind: "meta", run_id: runId, ts: new Date().toISOString(),
    origin: WORKER_ORIGIN, path: LOAD_PATH, cohort: COHORT_ID,
    session_id: session.session_id, session_profile_id: session.profile_id,
    workers: RUN.workers, turns: RUN.turns, arrival: RUN.arrival, seed: RUN.seed,
    max_tokens: RUN.max_tokens, profile_plan_mode: mode,
    sdk_tools: useTools ? ["Read", "Write", "Edit"] : [],
    max_tool_rounds: RUN.max_tool_rounds,
    thresholds: THRESHOLDS,
    profile_probe: {
      profile_id: probe.json?.profile_id, coach_runtime: probe.json?.coach_runtime,
      minor_cohort: probe.json?.minor_cohort,
    },
  });

  // --- The run ---
  const barrier = makeBarrier(RUN.workers);
  const t0 = Date.now();

  async function runStudent(student) {
    // Each worker gets its own deterministic stream, derived from the run seed.
    const rng = makeRng(RUN.seed + student.index * 7919);
    const { guest, turns } = buildTurns(rng, RUN.turns);
    const history = [];
    // Virtual workspace: Read returns the real skeleton, Write persists so the
    // next Read returns what the coach actually wrote.
    const ws = newWorkspaceState(guest.name);

    if (RUN.arrival === "stagger") await sleep(randInt(rng, 0, RUN.stagger_ms));

    for (const turn of turns) {
      if (RUN.arrival === "barrier") await barrier();
      else if (RUN.arrival === "burst" && turn.idx === 0) await barrier();

      history.push({ role: "user", content: turn.text });

      // A production "turn" is not one request. The coach Reads index.html,
      // Writes it back, and only then speaks — each round trip is its own
      // /v1/messages call. Loop until the model stops asking for tools.
      let rounds = 0;
      let rec = null;
      let turnOutTokens = 0;
      let turnMs = 0;
      const turnStartRel = Date.now() - t0;
      const toolsUsed = [];

      for (;;) {
        rounds++;
        rec = await runTurn({
          workerUrl: WORKER_URL,
          path: LOAD_PATH,
          token: student.token,
          history,
          maxTokens: RUN.max_tokens,
          timeoutMs: RUN.turn_timeout_ms,
          tools: useTools ? toolDefs() : null,
        });

        turnOutTokens += rec.usage.output_tokens ?? 0;
        turnMs += rec.total_ms ?? 0;

        // Every ROUND is its own JSONL row — RPM and concurrency must count
        // requests, not conversational turns.
        const { assistant_text, blocks, ...slim } = rec;
        write({
          kind: "turn",
          run_id: runId,
          user: student.user,
          worker_index: student.index,
          profile: student.profile,
          guest: guest.name,
          turn_idx: turn.idx,
          turn_label: turn.label,
          round: rounds,
          heavy: turn.heavy,
          prompt_chars: turn.text.length,
          history_msgs: history.length,
          tool_uses: rec.tool_uses ?? [],
          workspace_writes: ws.writes,
          last_write_chars: ws.lastWriteChars,
          t_rel_start_ms: rec.t_start - t0,
          t_rel_end_ms: rec.t_start - t0 + (rec.total_ms ?? 0),
          ...slim,
        });

        const tag = rec.ok ? "ok " : `ERR(${rec.error_type})`;
        console.log(
          `[${student.user}] turn ${turn.idx}.${rounds} ${turn.label.padEnd(12)} ${tag} ` +
          `status=${rec.status} ttft=${rec.ttft_ms}ms total=${rec.total_ms}ms ` +
          `out=${rec.usage.output_tokens} in=${rec.usage.input_tokens} ` +
          `cache_read=${rec.usage.cache_read_input_tokens}` +
          (rec.tool_uses?.length ? ` tools=[${rec.tool_uses.join(",")}]` : "") +
          (rec.stop_reason === "max_tokens" ? " CLAMPED" : ""),
        );

        if (!rec.ok) {
          // Failed round: drop the dangling user message so the next turn's
          // request is still well-formed.
          while (history.length && history[history.length - 1].role === "user") history.pop();
          break;
        }

        // Feed the assistant turn back verbatim (text + tool_use blocks).
        const assistantBlocks = rec.blocks?.length
          ? rec.blocks
          : (rec.assistant_text ? [{ type: "text", text: rec.assistant_text }] : []);
        if (!assistantBlocks.length) break;
        history.push({ role: "assistant", content: assistantBlocks });

        const toolUseBlocks = assistantBlocks.filter((b) => b.type === "tool_use");
        if (rec.stop_reason !== "tool_use" || toolUseBlocks.length === 0) break;

        for (const b of toolUseBlocks) toolsUsed.push(b.name);
        history.push({
          role: "user",
          content: toolUseBlocks.map((b) => toolResultFor(b, ws)),
        });

        if (rounds >= RUN.max_tool_rounds) {
          console.warn(`[${student.user}] turn ${turn.idx}: hit max_tool_rounds=${RUN.max_tool_rounds}`);
          break;
        }
      }

      write({
        kind: "turn_summary",
        run_id: runId, user: student.user, turn_idx: turn.idx, turn_label: turn.label,
        heavy: turn.heavy, rounds, output_tokens: turnOutTokens,
        wall_ms: (Date.now() - t0) - turnStartRel, sum_request_ms: turnMs,
        tools_used: toolsUsed, workspace_writes: ws.writes,
      });

      if (turn.idx < turns.length - 1 && RUN.arrival !== "barrier") {
        await sleep(randInt(rng, RUN.think_min_ms, RUN.think_max_ms));
      }
    }
  }

  await Promise.all(students.map(runStudent));

  write({ kind: "end", run_id: runId, ts: new Date().toISOString(), wall_ms: Date.now() - t0 });
  await new Promise((r) => out.end(r));

  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${outPath}`);
  console.log(`report:  node ${join(HERE, "report.mjs")} ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
