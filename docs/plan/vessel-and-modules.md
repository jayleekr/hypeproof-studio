# Vessel and Modules

> Plan spec. Execution graph: [dag.yaml](./dag.yaml).
> Written 2026-09-04. Evidence: SK바이오팜 1회차 (2026-08-22), production D1/R2,
> `.github/workflows/`, *Hypeproof Lab Philosophy* §10 · §11 · §18.

Studio becomes the vessel that holds modules. This spec names the layers, fixes
what is currently in the wrong one, and stands up the first module — the
instructor live board.

**Read this before implementing any task in `dag.yaml`.** Numbers here are
measured, not estimated; do not restate them from memory and do not invent new
ones.

---

## 1. Four layers

| Layer | What | Tag | Speed | Reach | Rollback |
|---|---|---|---|---|---|
| **App** | Studio binary — the vessel | `v0.1.51` | 1–2 h | only those who reinstall | slow (reinstall) |
| **Service** | Worker — gateway, runtime | `w2026.09.04` | 30 s | **everyone, instantly** | 30 s |
| **Surface** | Instructor surface — console, board (Chalk) | `c0.1.0` | 30 s | instructors only | 30 s |
| **Module** | Curriculum, prompts, session-design files | `m2026.09.04` | instant | one cohort | pin previous version |

Module is **not** a train. It is data, not code — distribution, not deployment.
It lands by upload to KV/R2, so it is exempt from the live-class deploy freeze.

### Layer decision rule

Three questions, in order. Do not deliberate; answer them.

```
Does it REQUIRE local resources (filesystem, shell, screen)?
├ yes → App (v*)
└ no  → Is it code or data?
        ├ data → Module (m*)
        └ code → Who consumes it?
                 ├ participant runtime → Service (w*)
                 └ instructor / ops    → Surface (c*)
```

The rule is deliberately biased. The most expensive layer (App) opens only on
the first question, and that question asks an objective condition. "It feels
natural in the app" is not a reason. New work always drifts toward the most
familiar place, and App is the one place it effectively cannot leave — reinstall
cost means "put it in now, pull it out later" does not happen.

If the answer is ambiguous, it is not one thing — it is two. Split it and run
each half through again.

### The second question the rule does not ask

The three questions settle *where code goes*. They do not settle where a
**number** goes, and that turned out to be a separate trap.

> **A threshold on the slow train is a threshold you cannot calibrate.**

Task E shipped correct code with one guessed constant — a 60 s idle cut — inside
the client. Everything else it built rode the 30-second train; that one value
rode the 1–2 hour train plus a reinstall on every machine. It was also placed
there *before* the calibration that would settle it had been run, so the first
time §4's replay derives the real cut, the client's answer starts contradicting
the board's. Two numbers, both labelled "idle", one of them stale and
unfixable for a week.

It bought nothing: the value was derived entirely from inputs the client was
already sending. **A derived value transmitted alongside its own inputs belongs
on the side that can change fastest.**

So before placing any constant, ask:

- **Will this need to change based on data I do not have yet?** If yes, it may
  not go in the App layer. Send the inputs; derive on the Service or Surface
  side.
- **Is it derivable from something already crossing the boundary?** If yes,
  do not transmit it at all.

This is why §4 says *derive, don't guess* — and the rule has teeth only if the
derived value lives where a correction is cheap. Guessing is recoverable at 30
seconds; guessing is close to permanent at a reinstall.

---

## 2. Currently in the wrong layer

| Item | Today | Correct | Problem |
|---|---|---|---|
| Curriculum / prompts | compiled into `worker/src` | Module | fixing a prompt typo redeploys the gateway |
| Instructor console `/console` | inside the Service worker | Surface | instructor edits ship in the participant runtime artifact |
| Chalk tag split | rides the same worker | separate worker | splitting the tag does not split the deploy — one artifact ships |

### Why curriculum is the urgent one

Two independent arguments, both from the philosophy document.

**§18 lists this as a self-contradiction to guard against:**

> "AI가 바뀌었는데도 기존 Curriculum을 보호하기 위해 인간에 대한 가설을 수정하지 않는 경우"

When curriculum is compiled into the binary, changing it costs a code review and
a deploy, and shares a rollback unit with the gateway. **Whichever side has
friction changes less.** The architecture makes the failure mode the document
warns about into the default. Discipline does not beat this.

**§11's research loop does not close:**

```
Hypothesis → Human Asset → Product Experience → Human Behavior
          → Evidence → Reflection → Refined Hypothesis
```

The loop needs evidence attributable to *which curriculum produced it*. The
curriculum version **is** the experimental condition, and right now that
condition has no name — "Verify improved" cannot be qualified with "under which
curriculum."

§10 also places Curriculum and Studio side by side as Products — *"Curriculum
trains the assets · Studio stress-tests the assets."* That is not a
compiled-into relationship.

---

## 3. Broken data — fix before the board

Not a layer problem, but the board stands on it.

### #684 — the metric lies

`usage_log.status` is a hardcoded `200`, not an observed value. Both routes
(`chat.ts:551`, `messages.ts:457`) write the literal, and `record()` →
`persistUsage()` runs only on the success path, so **failed turns write no row
at all**.

```sql
SELECT status, COUNT(*) FROM usage_log GROUP BY status;
-- status=200   16,564 rows   2026-07-14 .. 2026-08-23
```

Seven weeks, every row 200, no other value ever. Consequences:

- Any `SUM(CASE WHEN status >= 400 ...)` query is structurally always 0. Past
  "zero errors" reports were vacuous statements.
- A student erroring constantly, a student who never opened Studio, and a
  student quietly doing fine are **identical in the data**.

Build the board on this and the student who most needs help renders as "fine."

**Caution:** `usage_log` is also the billing ledger. Adding failure rows means
usage aggregation must be changed to count successes only, or failures get
billed. `worker/test/d1-accounting.test.mjs` holds that contract.

### #680 — the post-hoc layer loses the same students

R2 session-log upload is a manual button. Nobody who gave up, or whose app died,
ever presses it. 2026-08-22 actual:

```
present:  SK34-CM6YPX-02 .. -10
missing:  SK34-CM6YPX-01 · -11 · -12 · -13 · -14
```

The two worst seats of the day are in the missing set. R2 retention is 90 days,
so these files disappear around **2026-11-20** — issues #670/#671/#675 currently
rest on circumstantial evidence that lives in them.

### The third gap — "quiet" means two things

Even with #684 fixed, an empty stretch is ambiguous: app died, laptop closed,
participant reading, participant gone. The instructor response differs. A
30–60 s heartbeat, independent of chat, splits *alive but not asking* from *not
alive*. Cheapest item on this list.

---

## 4. First module — instructor live board

On 2026-08-22 the only way to find a stuck seat was hand-querying D1. Three
times that day. What it showed, and what the instructor could not see:

| Seat | Actual | What walking the room showed |
|---|---|---|
| `-12` | 3 turns in 15 min, 250 s mean wait | looks like waiting |
| `-01` | 11 min no activity | "sitting still" |
| `-06` | 11 min no activity | "sitting still" |

The last two are the point: **walking cannot distinguish them.** A student who
is reading and a student who gave up look identical without a metric.

### Four rules

1. **Every roster row is always rendered.** Absence of activity is itself the
   signal, so a quiet seat must occupy a row. Today's admin panel shows recent
   N rows, so the quiet student — the one we most want — disappears first.
2. **First column is time-since-last-turn.** Ahead of any performance number.
3. **Readable in two seconds.** The instructor is walking with a phone. This is
   why it is a web surface, not a Studio panel.
4. **No prompt text.** See below.

### States the current data cannot distinguish

`stuck` · `quiet-but-alive` · `no-heartbeat` · `failing` — all four are the same
blank today. §3 must land first for these to separate.

### Calibration — do not guess thresholds

Labelled ground truth exists. 2026-08-22 is in D1 and the answer is known:
`-12` was stuck, `-01`/`-06` went quiet, the rest were fine.

Extract the verdict logic as a **pure function over rows** and replay that
session before any live run:

- **Positive control** — seats that were fine come back green. Catches an
  over-strict board, which turns instructor attention into noise and gets the
  tab closed.
- **Negative control** — `-12` comes back red. Catches a permissive board.
- **Derive, don't guess** — take the wait-time distribution from the real 16,564
  rows. ClassAid's 240 s inactivity threshold (arXiv 2602.06734, chosen to mimic
  instructor circulation) is a sanity check on the result, not a substitute for
  measuring.

Runs in milliseconds, no app required. See `.claude/rules/verification.md`.

### Privacy — zero prompt text is what makes this shippable

PIPA Art. 22-2 requires verified guardian consent to process personal data of
children under 14. That is why `analytics.upload_session_logs` is a hard
validator failure for minor cohorts today — the sensitive payload is **prompt
text**, and the lawful-collection procedure does not exist yet.

The board uses latency, token counts, error class, elapsed time, and an
artifact-changed boolean. All operational metadata already collected under the
existing basis, and sufficient for triage.

**A "recent question preview" column will be the most tempting feature and it
crosses the line that currently keeps this buildable.** Refuse it.

### Market — nothing to buy

Two categories, neither fits. **Classroom screen surveillance** (LanSchool,
Lightspeed, GoGuardian) reports what is on screen, not whether the
human–AI collaboration is working, and needs an agent installed on
participant-owned laptops. **Enterprise AI usage telemetry** (GitHub Copilot
metrics, GA 2026-02) is the closest architecture but its resolution is
day-granularity adoption reporting. The one worthwhile reference is academic:
**ClassAid** (arXiv 2602.06734) solves the same problem — per-student cards,
three named alerts with explicit thresholds, class aggregate before drill-down,
and a stated principle of preserving instructor authority.

---

## 5. Admission — four gates for anything new

Chalk, live preview, publish wizard, Sediment integration — the vessel keeps
gaining tenants. Each new one brings one page to its PR.

| # | Gate | Rejected when |
|---|---|---|
| 1 | **Layer declaration** — run §1's three questions | ambiguous → it is two things, split it |
| 2 | **Contract declaration** — exactly one, as a *data format* | two or more contracts; or "calls worker's X function" (that is coupling, not a contract) |
| 3 | **Drift lock** — a test asserting the contract | contract written but no test |
| 4 | **Exit plan** — one paragraph on how to remove it | "there is no way to remove it" → the layer is wrong, go back to gate 1 |

Gate 2's model is Chalk↔Studio: *"접점은 세션 설계 파일 1개. 이 접점만 지키면
두 제품은 독립적으로 간다"* (`hypeprooflab/products/PRODUCT-LINEUP.md`). The
number of contracts is the number of places that will later diverge.

Gate 3 exists because different layers deploy on different cadences, and
**different cadences always drift**. An old client hitting a new worker is the
normal path, not an edge case. This repo already has the idiom —
`worker/test/logs-upload.test.mjs` locks the client/server filename allowlist;
`worker/src/lib/scrub-secrets.ts` names its twin in a comment.

Gate 4 exists because a product that cannot be removed survives its own failure,
and the vessel becomes a landfill rather than a lab.

### The vessel owes contracts too

Rules on tenants alone cannot stop module N+1 from breaking module N.

- **Open on absence** — the app starts with zero modules present.
- **Closed on error** — a malformed module disables only itself; the app lives.
- **Ignorant of content** — the vessel knows the *format* only. The moment a
  branch in the app knows a specific module, it is no longer a vessel.
- **Announces lost capability** — no silent fallback. REQ-M30 already carries
  this lesson: one silent degradation was misdiagnosed as three separate product
  defects (#470, #471, #472).

Passing the gates is recorded as one entry in `products.yaml` at the repo root.
CI checks exactly two things: a new top-level directory has a registry entry,
and the declared `drift_lock` file exists and is in the test script. Layer
judgment and contract design are not things CI can evaluate — the artifact of
this process is that a human wrote the page.

---

## 6. Sequence

Authoritative ordering lives in [dag.yaml](./dag.yaml). Summary:

**Stage 1 — stand up the board (≈3.5 d).**
B (#684 status repair — worker only, no release) → E (heartbeat +
artifactChanged — one Studio release) → G (board, calibrated against 2026-08-22).

**Stage 2 — split the pipelines (≈2 d).**
A (dev channel — one conditional `--prerelease` flag; the auto-updater already
skips prereleases, so this is the only missing piece) · C (worker version
identifier) · D (#676 live-class deploy freeze) · E's client version header.

**Stage 3 — layers to their proper homes (≈4–5 d).**
F (Chalk into its own worker) → H (module distribution).

**F before G.** Building the board inside the Service worker and moving it later
costs a migration.

**Human gates** the orchestrator may never satisfy itself:
- E requires a Studio release to reach participants.
- G requires B to be **deployed to production** — its calibration replays real
  production rows.

---

## 7. Standing decisions

| Decision | Status |
|---|---|
| Four layers + tag prefixes `v*` `w*` `c*` `m*` | proposed |
| Board carries zero prompt text | proposed — blocking for minor cohorts |
| Four admission gates + `products.yaml` | proposed |
| Chalk as a separate Cloudflare Worker | proposed (supersedes "tag-only split") |
| Curriculum as a distribution channel | proposed — reverses an earlier "defer" |

The last row reverses an earlier judgment. The earlier reasoning was "30-second
rollback makes this coupling affordable," which assumed curriculum stays small
and internal. Once Studio is a vessel and curriculum is one of its modules, that
assumption is gone — and the argument moved from release hygiene to §2's
operating-loop precondition.
