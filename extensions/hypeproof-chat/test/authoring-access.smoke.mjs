// #1184 — who gets the instructor (Chalk) surface, and does the manifest
// actually gate it? Pure helpers + manifest assertions; no vscode host.
//
// Control samples first (.claude/rules/verification.md §2): a known-good
// issuer token must PASS and a known-good student token must FAIL. A gate
// only tested from one side is a gate tested from no side.

import assert from "node:assert/strict";
import fs from "node:fs";

const a = await import("../src/authoringAccess.ts");
const h = await import("../src/chatPanelHelpers.ts");
const surface = await import("../src/chalkSurfaceHelpers.ts");

/** Mint a token in the worker's real wire shape: base64url(payload) "." sig. */
const mint = (payload) =>
  Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "") + ".sig";

// ─── control samples ─────────────────────────────────────────────────
const ISSUER = mint({
  role: "issuer",
  c: "__issuer__",
  p: "__issuer__",
  scopes: [{ cohort: "boah-dental-2026-a", profiles: ["boah-dental-teaser-2026-s1"] }],
});
const LEGACY_ISSUER = mint({ c: "__issuer__", p: "__issuer__" }); // pre-`role` mint
const STUDENT = mint({ u: "student-01", c: "boah-dental-2026-a", p: "boah-dental-teaser-2026-s1" });

{
  // positive control — the thing that must be let through
  assert.equal(a.canAuthorWithToken(ISSUER), true);
  assert.equal(a.canAuthorWithToken(LEGACY_ISSUER), true);
  // negative control — the thing that must be kept out
  assert.equal(a.canAuthorWithToken(STUDENT), false);
  // nothing at all
  assert.equal(a.canAuthorWithToken(undefined), false);
  assert.equal(a.canAuthorWithToken(""), false);
  assert.equal(a.canAuthorWithToken("not-a-token"), false);
  assert.equal(a.canAuthorWithToken("a.b.c"), false); // 3-segment JWT is not our shape
  console.log("✅ canAuthor: issuer + legacy issuer pass, student/garbage do not");
}

// ─── resolveAuthoringAccess: which token answered ────────────────────
{
  assert.deepEqual(a.resolveAuthoringAccess({ issuerToken: ISSUER, participantToken: STUDENT }), {
    canAuthor: true,
    source: "issuer-secret",
    cohorts: ["boah-dental-2026-a"],
  });
  // 강사 whose only credential in this window is the issuer token
  assert.equal(
    a.resolveAuthoringAccess({ participantToken: ISSUER }).source,
    "participant-token",
  );
  // the student path — this is the regression that must never flip
  assert.deepEqual(a.resolveAuthoringAccess({ participantToken: STUDENT }), {
    canAuthor: false,
    source: "none",
    cohorts: [],
  });
  assert.equal(a.resolveAuthoringAccess({}).canAuthor, false);
  console.log("✅ resolveAuthoringAccess: 4 cases incl. the student negative");
}

// ─── subtitle ────────────────────────────────────────────────────────
{
  const one = a.resolveAuthoringAccess({ issuerToken: ISSUER });
  assert.equal(a.authoringSubtitle(one), "강사 · boah-dental-2026-a");
  const many = a.resolveAuthoringAccess({
    issuerToken: mint({ role: "issuer", scopes: [{ cohort: "x" }, { cohort: "y" }, { cohort: "x" }] }),
  });
  assert.equal(a.authoringSubtitle(many), "강사 · 2개 수업"); // deduped
  assert.equal(a.authoringSubtitle(a.resolveAuthoringAccess({ issuerToken: LEGACY_ISSUER })), "강사");
  assert.equal(a.authoringSubtitle(a.resolveAuthoringAccess({ participantToken: STUDENT })), "");
  console.log("✅ authoringSubtitle: 1 cohort / N cohorts / unknown / none");
}

// ─── one definition of the role, two readers ─────────────────────────
{
  // chatPanelHelpers' diagnostic and the surface gate must never disagree —
  // that is the whole reason isIssuerRolePayload was pulled out (#1184).
  for (const t of [ISSUER, LEGACY_ISSUER, STUDENT, "", "garbage"]) {
    assert.equal(h.looksLikeIssuerTokenUnverified(t), a.canAuthorWithToken(t), `disagreed on ${t}`);
  }
  console.log("✅ diagnostic and gate agree on all 5 samples");
}

// ─── the role literal lives in exactly one module ────────────────────
{
  const dir = new URL("../src/", import.meta.url);
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(new URL(d, dir), { withFileTypes: true })) {
      if (e.isDirectory()) { walk(`${d}${e.name}/`); continue; }
      if (!/\.ts$/.test(e.name)) continue;
      const body = fs.readFileSync(new URL(`${d}${e.name}`, dir), "utf8");
      for (const line of body.split("\n")) {
        // a comparison against the role value, not prose mentioning it
        if (/role\s*===\s*["']issuer["']/.test(line)) hits.push(`${d}${e.name}`);
      }
    }
  };
  walk("");
  assert.deepEqual(hits, ["authoringAccess.ts"], `role literal spread to: ${hits.join(", ")}`);
  console.log("✅ `role === \"issuer\"` appears in authoringAccess.ts only");
}

// ─── manifest: the view exists and is gated ──────────────────────────
{
  const m = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const views = m.contributes.views["hypeproof-chat"];
  const chalk = views.find((v) => v.id === "hypeproof-chat.chalk");
  assert.ok(chalk, "chalk view missing from the hypeproof-chat container");
  assert.equal(chalk.when, a.AUTHORING_CONTEXT_KEY);
  assert.notEqual(chalk.type, "webview", "the instructor surface must stay native");

  // The student chat view must NOT have picked up a gate.
  const panel = views.find((v) => v.id === "hypeproof-chat.panel");
  assert.equal(panel.when, undefined, "student chat view must stay ungated");
  assert.equal(panel.type, "webview");

  // Exactly one activity-bar container — a second one would be invisible
  // anyway (configurationDefaults hides the activity bar) and would need an
  // icon asset the Dev launcher does not copy.
  assert.equal(m.contributes.viewsContainers.activitybar.length, 1);

  // Instructor commands are palette-gated on the same key.
  const gated = new Set(
    m.contributes.menus.commandPalette
      .filter((e) => e.when === a.AUTHORING_CONTEXT_KEY)
      .map((e) => e.command),
  );
  for (const c of [
    "hypeproof-chat.openChalkSurface",
    "hypeproof-chat.chalk.openLessonPlan",
    "hypeproof-chat.chalk.openWeb",
  ]) {
    assert.ok(gated.has(c), `${c} is not palette-gated on canAuthor`);
    assert.ok(m.contributes.commands.some((x) => x.command === c), `${c} not declared`);
  }

  // The BOOTSTRAP must stay ungated. `mintStudentToken` is what prompts for
  // the issuer token in the first place, so a 강사 who has not pasted one yet
  // has canAuthor === false — gating it would lock the only door to itself.
  // Caught in the real Dev app (#1184), never by a unit test looking only at
  // the happy path.
  for (const c of ["hypeproof-chat.mintStudentToken", "hypeproof-chat.forgetIssuerToken"]) {
    assert.ok(!gated.has(c), `${c} must stay reachable before an issuer token exists`);
  }

  // No runtime dependency may appear — the Dev launcher hard-rejects a
  // `dependencies` drift, and the packaged build has no node_modules (#349).
  assert.equal(m.dependencies, undefined);
  console.log("✅ manifest: view gated + native, student view untouched, 3 commands gated, bootstrap ungated, no runtime deps");
}

// ─── the web entry carries no credential (ARC-02) ────────────────────
{
  const urls = [
    surface.chalkConsoleUrl("https://api.hypeproof-ai.xyz/v1"),
    surface.chalkConsoleUrl("http://localhost:8787/v1"),
  ];
  assert.equal(urls[0], "https://api.hypeproof-ai.xyz/console");
  // a local wrangler dev window must open the LOCAL Chalk, not production
  assert.equal(urls[1], "http://localhost:8787/console");
  for (const u of urls) {
    const parsed = new URL(u);
    assert.equal(parsed.search, "", "no query string may carry auth");
    assert.equal(parsed.hash, "", "no fragment may carry auth");
    assert.equal(parsed.username, "");
    assert.equal(parsed.password, "");
  }
  console.log("✅ chalkConsoleUrl: derived from proxyUrl, no auth in the URL");
}

// ─── the actions are real, declared commands with built-in icons ─────
{
  const m = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const declared = new Set(m.contributes.commands.map((c) => c.command));
  assert.ok(surface.CHALK_ACTIONS.length >= 3, "the surface must offer something to do");
  for (const action of surface.CHALK_ACTIONS) {
    assert.ok(declared.has(action.command), `${action.command} is in the tree but not declared`);
    assert.ok(action.label && action.detail, `${action.command} has no label/detail`);
    // codicon ids only — a media/ path here renders blank in the Dev app.
    assert.ok(!/[./]/.test(action.icon), `${action.command} icon looks like a path: ${action.icon}`);
  }
  console.log(`✅ CHALK_ACTIONS: ${surface.CHALK_ACTIONS.length} actions, all declared, codicons only`);
}

// ─── the lesson plan is a file, not a form ───────────────────────────
{
  assert.match(surface.LESSON_PLAN_FILENAME, /\.md$/);
  const t = surface.lessonPlanTemplate();
  assert.match(t, /^# /, "template must open as markdown");
  for (const req of ["CH-01", "CH-04", "EDU-01", "RUN-01"]) {
    assert.ok(t.includes(req), `template drops ${req}`);
  }
  console.log("✅ lesson plan: markdown seed carrying CH-01 · CH-04 · EDU-01 · RUN-01");
}
