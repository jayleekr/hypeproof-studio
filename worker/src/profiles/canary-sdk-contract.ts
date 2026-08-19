import type { Profile } from "./types";
// @ts-ignore — string import enabled via wrangler rules in wrangler.toml
import systemPromptMd from "../prompts/boah-dental-director-copyclone-2026-s1.md";

// CANARY — synthetic cohort that exists ONLY so CI can exercise the live
// gateway contract without touching a real classroom (#406, tests/rehearsal
// R7). No human is ever on this roster.
//
// Why it exists: on 2026-07-24 every agent-sdk turn was dying on an upstream
// 400 (the gateway pinned the model but forwarded the client's
// model-generation params) while the unit suite stayed green — a mocked
// upstream returns 200 for any body, so nothing could catch it. The only test
// that CAN catch it must hit the real gateway with the real SDK request shape,
// and that means passing the session/roster gate. Doing that on
// boah-dental-2026-a would mean opening a session on a cohort with 76 real
// people on its roster, every deploy. So the canary gets its own cohort and CI
// opens/closes a 1-hour session there instead. Blast radius: zero.
//
// FIDELITY IS THE POINT — this profile deliberately mirrors the adult
// copyclone track's request-shaping surface:
//   - the SAME system prompt file → byte-identical cached prefix (which also
//     means it shares copyclone's prompt cache instead of paying for its own)
//   - the SAME model policy (`hypeproof-default`, max_tokens 16384) → the
//     contract test validates the model that real students actually hit. A
//     canary pinned to a cheaper/newer model would prove nothing about them.
// What it deliberately does NOT mirror: `sdk_tools`. Those are client-side
// capability grants; the gateway contract never sees them, and the "only the
// adult copyclone cohort holds write/browser/subagents" invariant (worker
// smoke) stays exactly as narrow as it was.
//
// Cost: R7 sends ~6 requests at max_tokens 64 per deploy. Negligible.
export const profile: Profile = {
  id: "canary-sdk-contract",
  version: 1,
  display_name: "내부 카나리 — SDK 게이트웨이 계약 검증",
  audience: {
    // Adult-only. A minor cohort would drag in the child_* harness rules and,
    // more importantly, minors must never be a test fixture.
    age_range: [18, 99],
    language: "ko",
    parent_coaching: false,
  },
  model: {
    default: "hypeproof-default",
    fallback: "hypeproof-fast",
    max_tokens: 16384,
  },
  system_prompt: systemPromptMd as unknown as string,
  welcome: {
    greeting_md: "내부 계약 검증용 코호트입니다. 사람이 쓰는 트랙이 아닙니다.",
    // Never rendered (no human opens this cohort) but the harness requires a
    // non-empty set — keeping it real-shaped costs nothing.
    example_prompts: ["게이트웨이 계약 확인용 요청입니다"],
  },
  sandbox: {
    file_write: false,
    workspace_root: "~/HypeProofCanary",
    execute_shell: false,
    mcp_tools_enabled: [],
  },
  preview: {
    // Mirrors copyclone so buildCachedPrefix picks the same preview contract
    // (the prefix must stay byte-identical for the cache to be shared).
    type: "live_server",
    auto_start: false,
  },
  game: {
    template_tier: "website",
  },
  publishing: {
    enabled: false,
    strategy: "local_only",
  },
  assets_focus: ["verification_reflex"],
  essences_focus: [],
  input: {
    page_context: true,
    image_paste: true,
  },
  browser_control: {
    enabled: true,
    max_iterations: 8,
  },
  tools: { web_search: true, max_uses: 5 },
  // No sdk_tools: the gateway contract never reads them, and the write/browser/
  // subagents grant stays exclusive to the real adult copyclone cohort.
  coach_runtime: "agent-sdk",
  // Never surfaced in the instructor console — this is not a track anyone teaches.
  dashboard_hidden: true,
  session: {
    cohort_id: "canary-internal",
    series_total: 1,
    series_index: 1,
    hours: 1,
  },
  analytics: {
    log_user_messages: false,
    log_metadata: true,
    // #596 — 카나리아는 업로드 계층의 양성 대조군이다. 실코호트는 전부
    // 기본 OFF(동의 후 opt-in)이므로, 켜진 코호트가 하나는 있어야 통과
    // 경로를 테스트로 고정할 수 있다.
    upload_session_logs: true,
  },
  ux: {
    coach: {
      naming_mode: "fixed",
      fallback_name: "코치",
      naming_prompt_md: "",
      personality_prompt_md: "",
      revisit_on_entry: false,
    },
    // Harness requires at least one 'good' chip on every profile. Never shown.
    suggestions: {
      initial: [
        { text: "게이트웨이 계약 확인용 요청입니다", style: "good", caption: "내부 카나리" },
      ],
      follow_up: [],
    },
    hints: {
      short_input: { enabled: false, min_chars: 5, message_md: "" },
      roll_input_button: { enabled: false, label: "", probe_md: "" },
    },
    retry_button: { enabled: false, show_counter: false },
  },
};
