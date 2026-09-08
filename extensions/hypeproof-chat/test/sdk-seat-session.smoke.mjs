// Smoke tests for the per-seat coach session (#749 / AE-14).
//
// Two invariants, one file:
//   1. The vendored CLI's persistent state is scoped to a SEAT (this student,
//      this cohort profile, this frozen lesson version) instead of landing in
//      one directory shared by everyone who uses the machine.
//   2. One seat runs at most one coach turn at a time.
//
// Both are executed here, not pattern-matched: withCoachSeatLock is a real async
// function and the tests actually race it. The two source-level assertions at
// the bottom exist only because a correct helper is worthless if the coach
// forgets to call it.
//
// Run: node --experimental-strip-types test/sdk-seat-session.smoke.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const {
  SDK_CONFIG_DIR_NAME,
  CoachConcurrentRunError,
  sdkConfigDirFor,
  coachSeatKey,
  coachSeatKeyFor,
  coachSeatsInFlight,
  withCoachSeatLock,
} = await import("../src/sdkCoachHelpers.ts");

const seatOf = (token, profileId, lessonVersion) =>
  coachSeatKeyFor({
    token,
    profile: { profile_id: profileId, lesson: lessonVersion ? { version: lessonVersion } : undefined },
  });

// ─── The seat key separates the people who share a classroom PC ──────────────
{
  const a = seatOf("token-student-a", "sk-biopharm-kids-s1", "2026.09.01");
  const b = seatOf("token-student-b", "sk-biopharm-kids-s1", "2026.09.01");

  assert.notEqual(a, b, "two students on one cohort must not share a seat");

  // Stability is the other half of the contract: a seat that changed per turn
  // would scope the directory correctly and still make resuming impossible.
  assert.equal(
    a,
    seatOf("token-student-a", "sk-biopharm-kids-s1", "2026.09.01"),
    "the same student on the same lesson keeps one seat across turns",
  );

  // A re-frozen lesson is a new lesson: its version bump must not resume the
  // session that was mid-flight on the previous content.
  assert.notEqual(
    a,
    seatOf("token-student-a", "sk-biopharm-kids-s1", "2026.09.02"),
    "a lesson version bump starts a new seat",
  );

  // Same person, different cohort — the profile is part of the seat.
  assert.notEqual(
    a,
    seatOf("token-student-a", "sk-biopharm-adult-s1", "2026.09.01"),
    "the cohort profile is part of the seat",
  );
}

// ─── The token is hashed, never written ─────────────────────────────────────
{
  const token = "hps_live_2f9c1e_do_not_write_me_to_disk";
  const seat = seatOf(token, "cohort", "1.0.0");
  assert.ok(
    !seat.includes(token) && !seat.includes("do_not_write_me"),
    "the seat key must not embed the workshop token",
  );
  assert.ok(
    !sdkConfigDirFor({ HOME: "/Users/student" }, seat).includes("do_not_write_me"),
    "the config dir path must not embed the workshop token",
  );
}

// ─── The seat key is always one safe path segment ───────────────────────────
{
  const hostile = [
    seatOf("t", "../../etc", "1"),
    seatOf("t", "a/b\\c", "1"),
    seatOf("t", "..", ".."),
    seatOf("t", "", ""),
    seatOf(undefined, undefined, undefined),
    seatOf("t", "  ", "  "),
    seatOf("t", "이름", "판"),
  ];
  for (const seat of hostile) {
    assert.ok(!seat.includes("/") && !seat.includes("\\"), `seat must be one segment: ${seat}`);
    assert.ok(seat !== "." && seat !== "..", `seat must not be a traversal: ${seat}`);
    assert.ok(seat.length > 0, "seat must never be empty");
    assert.ok(
      /^[A-Za-z0-9._~-]+$/.test(seat),
      `seat must stay filesystem-safe on Windows too: ${seat}`,
    );
  }
  // Nothing readable left → the fallbacks, not an empty or dot-only segment.
  assert.equal(seatOf(undefined, undefined, undefined), "profile~nolesson~anon");
}

// ─── The seat lands under the config dir, on both platform branches ─────────
{
  const seat = seatOf("token-student-a", "cohort", "1.0.0");

  assert.equal(
    sdkConfigDirFor({ APPDATA: "C:/Users/s/AppData/Roaming" }, seat),
    `C:/Users/s/AppData/Roaming/HypeProof-Studio/${SDK_CONFIG_DIR_NAME}/${seat}`,
  );
  assert.equal(
    sdkConfigDirFor({ HOME: "/Users/student" }, seat),
    `/Users/student/.hypeproof-studio/${SDK_CONFIG_DIR_NAME}/${seat}`,
  );
  assert.equal(
    sdkConfigDirFor({ USERPROFILE: "C:/Users/s" }, seat),
    `C:/Users/s/.hypeproof-studio/${SDK_CONFIG_DIR_NAME}/${seat}`,
  );
  assert.equal(sdkConfigDirFor({}, seat), `.hypeproof-studio/${SDK_CONFIG_DIR_NAME}/${seat}`);

  // REQ-M13 survives the change: the point of this directory is that stored
  // Claude Code / Desktop credentials cannot outrank the workshop token, and a
  // seat suffix must not reintroduce ~/.claude anywhere in the path.
  for (const env of [{ APPDATA: "C:/x" }, { HOME: "/h" }, {}]) {
    assert.ok(
      !sdkConfigDirFor(env, seat).includes(".claude"),
      "the coach config dir must never resolve into ~/.claude",
    );
  }
}

// ─── Negative control: no seat key → byte-identical to the pre-#749 path ────
// This is what proves the new argument is additive. If a caller is missed, it
// keeps the old shared directory rather than silently writing somewhere new.
{
  for (const env of [
    { APPDATA: "C:/Users/s/AppData/Roaming" },
    { HOME: "/Users/student" },
    { USERPROFILE: "C:/Users/s" },
    {},
  ]) {
    const withNothing = sdkConfigDirFor(env);
    assert.equal(sdkConfigDirFor(env, undefined), withNothing);
    assert.equal(sdkConfigDirFor(env, ""), withNothing, "an empty seat is not a seat");
    assert.equal(sdkConfigDirFor(env, "   "), withNothing, "a blank seat is not a seat");
    assert.ok(!withNothing.endsWith("/"), "no trailing separator when there is no seat");
  }
}

// ─── sdkSeatKey composes the three parts it is given ────────────────────────
{
  assert.equal(
    coachSeatKey({ profileId: "p", lessonVersion: "v", tokenDigest: "d" }),
    "p~v~d",
    "the seat key is profile~lesson~digest",
  );
  assert.equal(
    coachSeatKey({ profileId: "p", tokenDigest: "d" }),
    "p~nolesson~d",
    "a cohort with no frozen lesson still gets a stable seat",
  );
}

// ─── The lock refuses a second turn on the SAME seat ────────────────────────
{
  const seat = "cohort~1.0.0~deadbeef";
  let release;
  const held = new Promise((r) => (release = r));

  const first = withCoachSeatLock(seat, () => held);
  assert.deepEqual(coachSeatsInFlight(), [seat], "the seat is held while the turn runs");

  await assert.rejects(
    () => withCoachSeatLock(seat, async () => "should not run"),
    (err) => {
      assert.ok(err instanceof CoachConcurrentRunError, "the refusal has its own class");
      assert.equal(err.seatKey, seat);
      // The student reads this. It has to say what to do, not name a subsystem.
      assert.match(err.message, /이미 실행 중인 요청/);
      assert.ok(!/SDK|seat|lock/i.test(err.message), "no internals in the student-facing line");
      return true;
    },
    "a second turn on one seat is refused",
  );

  // The refused run never started: its body must not have executed.
  let ran = false;
  await withCoachSeatLock(seat, async () => (ran = true)).catch(() => {});
  assert.equal(ran, false, "the refused run's body never executes");

  release("done");
  assert.equal(await first, "done", "the first turn still returns its value");
  assert.deepEqual(coachSeatsInFlight(), [], "the seat is released when the turn ends");
}

// ─── Positive control: a DIFFERENT seat is never blocked ───────────────────
// The control that catches a too-strict guard. A global lock would pass every
// assertion above and fail here — and it would break a shared classroom PC in
// exactly the way this change is meant to fix.
{
  let release;
  const held = new Promise((r) => (release = r));
  const first = withCoachSeatLock("seat-a", () => held);

  assert.equal(
    await withCoachSeatLock("seat-b", async () => "ran"),
    "ran",
    "another student's turn runs while the first is in flight",
  );

  release("a");
  await first;
  assert.deepEqual(coachSeatsInFlight(), []);
}

// ─── A failed turn releases the seat ───────────────────────────────────────
// Without the finally, one thrown turn wedges that student for the rest of the
// session and the only fix is restarting Studio.
{
  const seat = "seat-throws";
  await assert.rejects(
    () => withCoachSeatLock(seat, async () => { throw new Error("upstream died"); }),
    /upstream died/,
    "the turn's own error propagates unchanged",
  );
  assert.deepEqual(coachSeatsInFlight(), [], "a thrown turn still releases the seat");

  assert.equal(
    await withCoachSeatLock(seat, async () => "recovered"),
    "recovered",
    "the seat accepts a new turn after a failure",
  );
}

// ─── An aborted turn releases the seat ─────────────────────────────────────
// Stop is the most common way a turn ends early, and it arrives as a rejection.
{
  const seat = "seat-aborts";
  const abort = Object.assign(new Error("Aborted"), { name: "AbortError" });
  await assert.rejects(() => withCoachSeatLock(seat, async () => { throw abort; }));
  assert.deepEqual(coachSeatsInFlight(), [], "an aborted turn still releases the seat");
}

// ─── Sequential turns are never refused ────────────────────────────────────
{
  const seat = "seat-sequential";
  for (let i = 0; i < 3; i++) {
    assert.equal(await withCoachSeatLock(seat, async () => i), i, "turn after turn is fine");
  }
  assert.deepEqual(coachSeatsInFlight(), []);
}

// ─── The coach actually uses both ──────────────────────────────────────────
// Source-level, and deliberately so: sdkCoach.ts cannot be imported standalone
// (it reaches vscode-bound modules), so this is the only executable check that
// the wiring exists. It is a backstop for the helpers above, not their proof.
{
  const coach = readFileSync(join(here, "..", "src", "sdkCoach.ts"), "utf8");

  // #749 후속 — 잠금은 이제 코치가 아니라 **호스트**가 잡는다. 코치 안에 두면
  // proxy 코호트 전체가 무방비이고, SdkUnavailableError 폴백이 잠금 밖에서 돈다.
  // 호출을 찾는다 — 이름만 언급하는 주석까지 잡으면 계약이 아니라 산문을 재게 된다.
  assert.doesNotMatch(
    coach,
    /withCoachSeatLock\(/,
    "코치는 스스로 잠그지 않는다 — 그러면 폴백이 울타리 밖으로 나간다",
  );

  const host = readFileSync(join(here, "..", "src", "chatPanelProvider.ts"), "utf8");
  assert.match(
    host,
    /await withCoachSeatLock\(coachSeatKeyFor\(\{ token: token \?\? undefined, profile: profile \?\? undefined \}\), async \(\) => \{/,
    "호스트가 턴 전체를 좌석 잠금으로 감싼다",
  );

  // 그리고 그 잠금이 **런타임 분기 바깥**에 있어야 한다. 안쪽에 있으면 한 경로만
  // 덮인다 — 그게 고치는 결함이다.
  const lockAt = host.indexOf("await withCoachSeatLock(");
  const sdkBranchAt = host.indexOf('if (runtime === "agent-sdk") {', lockAt);
  const proxyElseAt = host.indexOf("// #278 Phase 3 — browser loop for opted-in cohorts", lockAt);
  assert.ok(lockAt > 0 && sdkBranchAt > lockAt, "잠금이 SDK 분기보다 먼저 잡힌다");
  assert.ok(proxyElseAt > lockAt, "proxy 분기도 잠금 안에 있다");
  assert.match(
    coach,
    /sdkConfigDirFor\(process\.env,\s*coachSeatKeyFor\(args\)\)/,
    "the CLI config dir is scoped to the seat",
  );
  assert.doesNotMatch(
    coach,
    /sdkConfigDirFor\(process\.env\)/,
    "no remaining call leaves the config dir shared across students",
  );
}

console.log("sdk-seat-session smoke OK");
