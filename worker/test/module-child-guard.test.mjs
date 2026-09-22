// dag task H, attempt 2 — the harness rule that lives in PROMPT TEXT must
// survive the prompt becoming runtime-loadable.
//
// `scripts/cohort-harness/rules.yaml` → child.required_prompt_phrase is
// enforced by validate.py (`child_missing_url_ban`, severity fail) and runs in
// CI on the COMPILED profiles. Task H made the prompt text a KV module, so a
// published module could drop the phrase and never meet the harness. This file
// carries the assertion across that boundary and locks the two sides together:
//
//   PLANTED ANSWER (the defect) — a child-cohort module WITHOUT the phrase must
//     be refused by the worker at resolve time (served prompt still has the
//     phrase, fallback announced) AND by the publisher before any write.
//     Written first and run against b25c9fb, where it FAILS on both counts.
//   POSITIVE — a child module WITH the phrase, and an adult module without it,
//     are both accepted (the guard must not turn into a blanket rejection).
//   DRIFT LOCK — the worker's requirement is DERIVED from rules.yaml, not
//     copied: (1) the TS reader of rules.yaml agrees with validate.py's own
//     parser on the `child` block and `thresholds.child_age_max`; (2) for the
//     same stripped profile, validate.py exits 1 with child_missing_url_ban
//     and the worker's requirement rejects — same verdict from both sides.
//
// Needs python3 (CI has it: pr-ci.yml validate-profiles). A drift lock that
// skips when python is missing is not a lock, so this fails loudly instead.
//
// Run: node --experimental-strip-types test/module-child-guard.test.mjs

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockEnv, PROFILE } from "./harness/index.mjs";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULES_PATH = join(WORKER, "scripts/cohort-harness/rules.yaml");
const VALIDATE_PY = join(WORKER, "scripts/cohort-harness/validate.py");

const { getProfile } = await import("../src/profiles/index.ts");
const { resolveProfile, makeModuleDoc, moduleDocKey, modulePinKey, _resetModuleMemoForTests } =
  await import("../src/lib/modules.ts");

// The phrase, read from the source of truth by the TEST (not from the code
// under test) so a wrong derivation in the worker cannot agree with itself.
const rulesText = readFileSync(RULES_PATH, "utf8");
const PHRASE = /^\s*required_prompt_phrase:\s*"(.+)"\s*$/m.exec(rulesText)?.[1];
assert.ok(PHRASE, "rules.yaml declares child.required_prompt_phrase");

const child = getProfile(PROFILE);
assert.ok(child.audience.age_range[1] <= 12, "harness profile is a child cohort (age_range)");
assert.ok(child.system_prompt.includes(PHRASE), "compiled child prompt carries the phrase (the CI-guarded state)");
const ADULT_ID = "boah-dental-teaser-2026-s1";
const adult = getProfile(ADULT_ID);
assert.ok(adult && adult.audience.parent_coaching === false && (adult.audience.age_range?.[1] ?? 99) > 12, "adult control profile");

const V = "m2026.09.04-7";
const stripped = child.system_prompt.split(PHRASE).join("이미지 파일은 자유롭게");
assert.equal(stripped.includes(PHRASE), false);
assert.ok(stripped.length > 1000);

const pinTo = (env, pid, version, text) =>
  makeModuleDoc({ kind: "curriculum", profileId: pid, version, content: { system_prompt: text } }).then((d) => {
    env._kv.set(moduleDocKey("curriculum", pid, version), JSON.stringify(d));
    env._kv.set(modulePinKey("curriculum", pid), JSON.stringify({ version, pinned_at: new Date().toISOString() }));
  });

async function quiet(fn) {
  const e = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = e;
  }
}

// ─── PLANTED ANSWER, worker side ─────────────────────────────────────────────
{
  _resetModuleMemoForTests();
  const env = createMockEnv();
  await pinTo(env, PROFILE, V, stripped);
  const { result: r, lines } = await quiet(() => resolveProfile(env, PROFILE));
  assert.ok(r.profile.system_prompt.includes(PHRASE), "WORKER: served prompt for a child cohort still contains the harness phrase");
  assert.notEqual(r.module.version, V, "WORKER: the phrase-less module is not the served version");
  assert.ok(r.module.fallback, "WORKER: the refusal is on the turn record");
  assert.equal(r.module.fallback.pinned, V);
  assert.match(r.module.fallback.reason, /required phrase/, "WORKER: the reason names the rule");
  assert.equal(lines.length, 1, "WORKER: one loud line");
  assert.ok(env._datapoints.some((d) => d.blobs?.[0] === "module_fallback" && d.blobs?.[2] === V), "WORKER: module_fallback datapoint");
}
console.log("✓ child-guard: WORKER refuses a child module without the harness phrase, serves a prompt that has it");

// ─── PLANTED ANSWER, publisher side ──────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "hps-child-guard-"));
  try {
    const file = join(dir, "stripped.md");
    writeFileSync(file, stripped);
    const p = spawnSync("node", ["--experimental-strip-types", "scripts/publish-module.ts", "validate", PROFILE, file], {
      cwd: WORKER,
      encoding: "utf8",
    });
    assert.notEqual(p.status, 0, `PUBLISHER: refuses before writing (exit ${p.status})\n${p.stdout}${p.stderr}`);
    assert.match(p.stderr, /required phrase/, "PUBLISHER: names the rule");
    // Positive: the real compiled prompt (has the phrase) is accepted.
    const ok = spawnSync(
      "node",
      ["--experimental-strip-types", "scripts/publish-module.ts", "validate", PROFILE, join(WORKER, "src/prompts/sk-biopharm-kids-quest-3-4.md")],
      { cwd: WORKER, encoding: "utf8" },
    );
    assert.equal(ok.status, 0, `PUBLISHER: accepts the compiled child prompt\n${ok.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log("✓ child-guard: PUBLISHER refuses the same module before any KV write");

// ─── POSITIVE — the guard is narrow ──────────────────────────────────────────
{
  _resetModuleMemoForTests();
  const env = createMockEnv();
  await pinTo(env, PROFILE, V, "# v7\n" + child.system_prompt);
  const r = await resolveProfile(env, PROFILE);
  assert.equal(r.module.version, V, "child module WITH the phrase is served");
  assert.equal(r.module.fallback, undefined);

  _resetModuleMemoForTests();
  const env2 = createMockEnv();
  await pinTo(env2, ADULT_ID, V, "# adult v7 — no child phrase here\n" + adult.system_prompt.split(PHRASE).join(""));
  const r2 = await resolveProfile(env2, ADULT_ID);
  assert.equal(r2.module.version, V, "adult module without the phrase is served — the rule is a CHILD rule");
  assert.equal(r2.module.fallback, undefined);
}
console.log("✓ child-guard: POSITIVE — child module with phrase accepted; adult module without it accepted");

// ─── DRIFT LOCK — same verdict from validate.py and from the worker ──────────
{
  const py = spawnSync("python3", ["--version"], { encoding: "utf8" });
  assert.equal(py.status, 0, "python3 is required for the drift lock (CI: pr-ci.yml sets it up)");

  // (1) parser agreement: validate.py's own parse_rules_yaml vs the worker's reader.
  const { readHarnessRules, curriculumRequirementsFor, checkCurriculumRequirements } =
    await import("../src/lib/harness-rules.ts");
  const pyDump = spawnSync(
    "python3",
    [
      "-c",
      `import json,sys; sys.path.insert(0, ${JSON.stringify(dirname(VALIDATE_PY))}); import validate as v; ` +
        `r=v.parse_rules_yaml(open(${JSON.stringify(RULES_PATH)},encoding='utf-8').read()); ` +
        `print(json.dumps({'child': r.get('child'), 'child_age_max': (r.get('thresholds') or {}).get('child_age_max')}, ensure_ascii=False))`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(pyDump.status, 0, pyDump.stderr);
  const pyRules = JSON.parse(pyDump.stdout);
  const tsRules = readHarnessRules();
  assert.deepEqual({ child: tsRules.child, child_age_max: tsRules.child_age_max }, pyRules, "TS reader == validate.py parser on the child block");
  assert.equal(tsRules.child.required_prompt_phrase, PHRASE);

  // (2) verdict agreement on a stripped profile.
  const strippedProfile = { ...child, system_prompt: stripped };
  const dir = mkdtempSync(join(tmpdir(), "hps-drift-"));
  try {
    const f = join(dir, "profiles.json");
    writeFileSync(f, JSON.stringify([strippedProfile, adult]));
    const v = spawnSync("python3", [VALIDATE_PY, f, "--json"], { encoding: "utf8" });
    assert.equal(v.status, 1, `validate.py must FAIL the stripped child profile\n${v.stdout}${v.stderr}`);
    const out = JSON.parse(v.stdout);
    const findings = Array.isArray(out) ? out : out.findings;
    const hit = findings.find((x) => x.check === "child_missing_url_ban" && x.profile === PROFILE);
    assert.ok(hit && hit.severity === "fail", "validate.py: child_missing_url_ban at fail");
    assert.equal(findings.some((x) => x.check === "child_missing_url_ban" && x.profile === ADULT_ID), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const reqChild = curriculumRequirementsFor(child);
  assert.deepEqual(reqChild.required_phrases, [PHRASE], "worker derives exactly the harness phrase for a child cohort");
  assert.match(checkCurriculumRequirements(stripped, reqChild) ?? "", /required phrase/, "worker rejects the stripped text");
  assert.equal(checkCurriculumRequirements(child.system_prompt, reqChild), null);
  assert.deepEqual(curriculumRequirementsFor(adult).required_phrases, [], "no child requirement for an adult cohort");
  // Harness classification: parent_coaching alone, or age_range alone, makes a child.
  assert.deepEqual(
    curriculumRequirementsFor({ ...adult, audience: { ...adult.audience, parent_coaching: true } }).required_phrases,
    [PHRASE],
  );
  assert.deepEqual(
    curriculumRequirementsFor({ ...adult, audience: { ...adult.audience, age_range: [10, 12] } }).required_phrases,
    [PHRASE],
  );
}
console.log("✓ child-guard: DRIFT LOCK — rules.yaml read identically by validate.py and the worker; same verdict");

// ─── #692 RULES INTEGRITY — a deleted key must not read as "nothing required" ─
//
//   PLANTED ANSWER — delete `child.required_prompt_phrase` from rules.yaml and
//     the pre-#692 readers both go quiet: validate.py's `if req and ...` passes
//     and the worker derives an empty requirement list. Nothing turns red.
//     Now: validate.py exits 2 (broken rules, not a bad profile) and the worker
//     refuses the child cohort's module — including one whose text is FINE,
//     because "the harness cannot check this" is not "this passed".
//   CONTROL — an adult cohort is unaffected by the same stripped file, and the
//     intact file keeps every cohort working (asserted by the blocks above).
{
  const { readHarnessRules, curriculumRequirementsFor, checkCurriculumRequirements, missingRequiredKeys, parseRulesYaml } =
    await import("../src/lib/harness-rules.ts");

  assert.deepEqual(missingRequiredKeys(parseRulesYaml(rulesText)), [], "the shipped rules.yaml declares every required key");

  const strippedRules = rulesText
    .split("\n")
    .filter((l) => !/^\s{2}required_prompt_phrase:/.test(l))
    .join("\n");
  const noPhrase = readHarnessRules(strippedRules);
  assert.deepEqual(noPhrase.missing_keys, ["child.required_prompt_phrase"], "TS reader names the deleted key");

  const reqStripped = curriculumRequirementsFor(child, noPhrase);
  assert.ok(reqStripped.rules_error, "child cohort fails closed when its rule is gone");
  assert.deepEqual(reqStripped.required_phrases, [], "and claims no phrase it cannot derive");
  assert.match(
    checkCurriculumRequirements(child.system_prompt, reqStripped) ?? "",
    /rules are incomplete/,
    "even a GOOD child prompt is refused while the rule is missing — the whole point",
  );
  assert.equal(
    curriculumRequirementsFor(adult, noPhrase).rules_error,
    undefined,
    "an adult cohort is not taken down by a missing CHILD key",
  );

  // Deleting the declaration block itself is also a hard failure.
  const noDecl = rulesText
    .split("\n")
    .filter((l) => !/^required_keys:/.test(l) && !/^ {2}- (assets|thresholds\.|publishing\.strategies|child\.)/.test(l))
    .join("\n");
  assert.deepEqual(readHarnessRules(noDecl).missing_keys, ["required_keys"], "the guard list cannot be deleted either");
  assert.ok(curriculumRequirementsFor(child, readHarnessRules(noDecl)).rules_error);

  // Same verdict on the python side: exit 2, distinct from a profile violation.
  const dir = mkdtempSync(join(tmpdir(), "hps-integrity-"));
  try {
    const rf = join(dir, "rules.yaml");
    const pf = join(dir, "profiles.json");
    writeFileSync(pf, JSON.stringify([child, adult]));
    writeFileSync(rf, strippedRules);
    const a = spawnSync("python3", [VALIDATE_PY, pf, "--rules", rf], { encoding: "utf8" });
    assert.equal(a.status, 2, `validate.py must exit 2 on a gutted rules file\n${a.stdout}${a.stderr}`);
    assert.match(a.stderr, /missing required key\(s\): child\.required_prompt_phrase/);
    writeFileSync(rf, noDecl);
    const b = spawnSync("python3", [VALIDATE_PY, pf, "--rules", rf], { encoding: "utf8" });
    assert.equal(b.status, 2, "validate.py must exit 2 when required_keys itself is gone");
    // The intact file still exits on profile findings only (0 or 1), never 2.
    writeFileSync(rf, rulesText);
    const c = spawnSync("python3", [VALIDATE_PY, pf, "--rules", rf], { encoding: "utf8" });
    assert.notEqual(c.status, 2, `the shipped rules file must not trip the integrity check\n${c.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log("✓ child-guard: #692 — a deleted rules key fails closed on both sides (exit 2 · module refused)");

// ─── #692 후속 훑기 — 같은 모양의 다른 severity: fail 규칙 ──────────────────
//
// 이슈의 마지막 요청은 "같은 논리가 다른 severity: fail 규칙에도 적용되는지
// 훑어라" 였다. 훑었더니 하나 나왔다: `publishing_promise_contradiction` 은
// `publishing.promise_phrases` 를 읽고, 그 목록이 사라지면 히트 0건이 되어
// 조용히 통과한다 — child.required_prompt_phrase 와 정확히 같은 모양이다.
//
//   PLANTED ANSWER — 발행이 꺼져 있는데 프롬프트가 공개를 약속하는 합성 시료를
//     만든다. 출고 상태에서는 규칙이 잡고(exit 1), 목록을 지우면 잡지 못한다.
//     required_keys 가 그 삭제를 exit 2 로 막는다.
//   CONTROL — 이 키는 CI 전용이다. 워커는 `child.` 접두 키만 보므로 이것이
//     비어도 아동 코호트 서빙은 계속된다. 빌드를 세우는 것과 수업을 세우는 것은
//     다른 사건이고, 그 구분이 깨지면 CI 규칙 하나가 교실을 멈춘다.
{
  const { readHarnessRules, curriculumRequirementsFor } = await import("../src/lib/harness-rules.ts");

  const stripPhrases = (text) => text.replace(/\n  promise_phrases:\n(?:    - .*\n)+/, "\n");
  const noPhrases = stripPhrases(rulesText);
  assert.equal(noPhrases.includes("promise_phrases:"), false, "fixture actually removed the list");

  // 합성 시료: publishing.enabled=false 인데 프롬프트가 "인터넷에 공개" 를 약속한다.
  const promiser = {
    ...adult,
    id: "synthetic-promise-probe",
    publishing: { ...(adult.publishing ?? {}), enabled: false },
    system_prompt: adult.system_prompt + "\n\n만든 결과물을 인터넷에 공개해 드릴게요.",
  };

  const dir = mkdtempSync(join(tmpdir(), "hps-promise-"));
  try {
    const pf = join(dir, "profiles.json");
    const rf = join(dir, "rules.yaml");
    writeFileSync(pf, JSON.stringify([promiser]));

    writeFileSync(rf, rulesText);
    const shipped = spawnSync("python3", [VALIDATE_PY, pf, "--rules", rf, "--json"], { encoding: "utf8" });
    assert.equal(shipped.status, 1, "출고 상태에서는 약속 모순을 잡아 exit 1 이어야 한다");
    assert.ok(
      JSON.parse(shipped.stdout).findings.some((f) => f.check === "publishing_promise_contradiction"),
      "publishing_promise_contradiction 이 실제로 걸린다",
    );

    writeFileSync(rf, noPhrases);
    const gutted = spawnSync("python3", [VALIDATE_PY, pf, "--rules", rf], { encoding: "utf8" });
    assert.equal(gutted.status, 2, `목록이 사라지면 exit 2 (조용한 통과가 아니라)\n${gutted.stdout}${gutted.stderr}`);
    assert.match(gutted.stderr, /missing required key\(s\): publishing\.promise_phrases/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // CONTROL — CI 전용 키의 부재가 서빙을 멈추지 않는다.
  const rules = readHarnessRules(noPhrases);
  assert.deepEqual(rules.missing_keys, ["publishing.promise_phrases"], "워커도 무엇이 빠졌는지는 안다");
  assert.equal(
    curriculumRequirementsFor(child, rules).rules_error,
    undefined,
    "그러나 아동 코호트 서빙은 계속된다 — 이 키는 CI 규칙이지 서빙 관문이 아니다",
  );
  assert.deepEqual(curriculumRequirementsFor(child, rules).required_phrases, [PHRASE]);
}
console.log("✓ child-guard: #692 훑기 — promise_phrases 도 같은 구멍이었다 (CI 는 막고, 서빙은 안 멈춘다)");

// ─── #693 the guard cannot be disarmed by forgetting an argument ─────────────
//
//   PLANTED ANSWER — call validateModuleDoc WITHOUT `requirements`, the way
//     lib/lesson-delivery.ts and lib/native-assessment.ts already call it. Before
//     #693 the child phrase check was skipped and a stripped child curriculum
//     validated `ok`. The requirement is now derived from `profileId`.
{
  const { validateModuleDoc } = await import("../src/lib/modules.ts");
  const mk = (pid, text) =>
    makeModuleDoc({ kind: "curriculum", profileId: pid, version: V, content: { system_prompt: text } });

  const strippedDoc = await mk(PROFILE, stripped);
  const forgot = await validateModuleDoc(strippedDoc, { kind: "curriculum", profileId: PROFILE });
  assert.equal(forgot.ok, false, "a caller that forgets `requirements` still gets the child guard");
  assert.match(forgot.reason, /required phrase/);

  const goodDoc = await mk(PROFILE, child.system_prompt);
  assert.equal((await validateModuleDoc(goodDoc, { kind: "curriculum", profileId: PROFILE })).ok, true, "a valid child module still passes");

  const adultDoc = await mk(ADULT_ID, stripped);
  assert.equal(
    (await validateModuleDoc(adultDoc, { kind: "curriculum", profileId: ADULT_ID })).ok,
    true,
    "derivation does not turn the child rule into a blanket rule",
  );

  // `null` is the explicit opt-out — deliberate, and visible in the call site.
  assert.equal((await validateModuleDoc(strippedDoc, { kind: "curriculum", profileId: PROFILE, requirements: null })).ok, true);

  // An id we cannot classify fails closed rather than passing unchecked.
  const unknownDoc = await mk("no-such-cohort-xyz", stripped);
  const unknown = await validateModuleDoc(unknownDoc, { kind: "curriculum", profileId: "no-such-cohort-xyz" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /unknown profile/);
}
console.log("✓ child-guard: #693 — requirements derived from profile_id; omission no longer disarms the gate");

console.log("module-child-guard: all green");
