// #811 — the image boundary on the Agent SDK path.
//
//   PLANTED ANSWER (the defect) — a cohort that never opted into
//     `input.image_paste` (both registered CHILD cohorts) had its
//     participant-supplied image blocks forwarded untouched, because
//     routes/messages.ts contained no image handling at all. The proxy path
//     has dropped them since the copyclone work.
//   CONTROL (the thing that stopped this being fixed) — an image inside a
//     `tool_result` block is the coach's own screenshot, arriving in a
//     USER-ROLE message. It must survive every filter, or the browser loop of
//     an adult cohort breaks silently. Asserted in both shapes.
//   CAPS — count and size are not policy: they bound cost and abuse on both
//     sides of that boundary, for every cohort.
//
// Run: node --experimental-strip-types test/inbound-images.test.mjs

import assert from "node:assert/strict";

const {
  filterInboundImages,
  summarizeImageReport,
  MAX_IMAGES_PER_BLOCK_ARRAY,
  MAX_IMAGE_SOURCE_CHARS,
} = await import("../src/lib/inbound-images.ts");

const img = (data = "AAAA") => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
const text = (t) => ({ type: "text", text: t });
const toolResult = (blocks) => ({ type: "tool_result", tool_use_id: "tu_1", content: blocks });

const OPT_IN = { allowUserImages: true };
const OPT_OUT = { allowUserImages: false };

// ─── PLANTED ANSWER — the participant's image is dropped for a cohort that
//     did not opt in, and kept for one that did. ────────────────────────────
{
  const msgs = [{ role: "user", content: [text("이것 좀 봐"), img()] }];

  const out = filterInboundImages(msgs, OPT_OUT);
  assert.equal(out.touched, true);
  assert.deepEqual(out.report, { user_dropped: 1, user_capped: 0, tool_result_capped: 0 });
  assert.deepEqual(out.messages[0].content, [text("이것 좀 봐")], "the prose survives, the image does not");
  assert.deepEqual(msgs[0].content.length, 2, "input is not mutated");

  const kept = filterInboundImages(msgs, OPT_IN);
  assert.equal(kept.touched, false);
  assert.equal(kept.messages, msgs, "an opted-in cohort is byte-identical — no churn, no copy");
}
console.log("✓ inbound-images: participant image dropped without image_paste, kept with it");

// ─── CONTROL — the coach's screenshot survives, in a user-role message, for a
//     cohort that did NOT opt into image_paste. This is the regression that
//     made the fix look risky; it is now pinned. ───────────────────────────
{
  const msgs = [
    { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "screenshot", input: {} }] },
    { role: "user", content: [toolResult([text("화면입니다"), img("SCREENSHOT")])] },
  ];
  const out = filterInboundImages(msgs, OPT_OUT);
  assert.equal(out.touched, false, "nothing was removed");
  assert.equal(out.messages, msgs);
  assert.deepEqual(out.report, { user_dropped: 0, user_capped: 0, tool_result_capped: 0 });

  // …and the same turn carrying BOTH: the screenshot stays, the pasted one goes.
  const mixed = [{ role: "user", content: [img("PASTED"), toolResult([img("SCREENSHOT")])] }];
  const r = filterInboundImages(mixed, OPT_OUT);
  assert.equal(r.report.user_dropped, 1);
  assert.equal(r.report.tool_result_capped, 0);
  assert.equal(r.messages[0].content.length, 1);
  assert.equal(r.messages[0].content[0].type, "tool_result");
  assert.equal(r.messages[0].content[0].content[0].source.data, "SCREENSHOT");
}
console.log("✓ inbound-images: tool_result screenshots survive — the discriminator is structural, not role-based");

// ─── CAPS — both sides, every cohort. ──────────────────────────────────────
{
  const many = Array.from({ length: MAX_IMAGES_PER_BLOCK_ARRAY + 3 }, (_, i) => img(`i${i}`));
  const r = filterInboundImages([{ role: "user", content: many }], OPT_IN);
  assert.equal(r.report.user_capped, 3);
  assert.equal(r.messages[0].content.length, MAX_IMAGES_PER_BLOCK_ARRAY);

  const huge = img("x".repeat(MAX_IMAGE_SOURCE_CHARS + 1));
  const s = filterInboundImages([{ role: "user", content: [huge] }], OPT_IN);
  assert.equal(s.report.user_capped, 1, "oversize image dropped even for an opted-in cohort");

  const tr = filterInboundImages(
    [{ role: "user", content: [toolResult([...many, huge])] }],
    OPT_OUT,
  );
  assert.equal(tr.report.tool_result_capped, 4, "the cap reaches inside tool_result too (3 over count + 1 oversize)");
  assert.equal(tr.messages[0].content[0].content.length, MAX_IMAGES_PER_BLOCK_ARRAY);
}
console.log("✓ inbound-images: count and size capped on both sides of the tool boundary");

// ─── TOTALITY — an unexpected shape degrades to "no filtering", never a 500. ─
{
  for (const weird of [undefined, null, "string", 42, {}, [null, 7, "x"], [{ role: "user" }], [{ role: "user", content: "plain" }]]) {
    const r = filterInboundImages(weird, OPT_OUT);
    assert.equal(r.touched, false);
    assert.equal(r.messages, weird);
  }
  // A url-source image is filtered by the same rule as a base64 one.
  const u = filterInboundImages([{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }] }], OPT_OUT);
  assert.equal(u.report.user_dropped, 1);
}
console.log("✓ inbound-images: total on unexpected shapes — degrades to no filtering, not to a 500");

// ─── the report is the loud part ───────────────────────────────────────────
{
  assert.equal(summarizeImageReport({ user_dropped: 0, user_capped: 0, tool_result_capped: 0 }), null);
  assert.equal(
    summarizeImageReport({ user_dropped: 2, user_capped: 1, tool_result_capped: 3 }),
    "user_dropped=2 user_capped=1 tool_result_capped=3",
  );
}
console.log("✓ inbound-images: every removal is reportable");

console.log("inbound-images: all green");
