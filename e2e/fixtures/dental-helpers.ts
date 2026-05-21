// Helpers for boah-dental-teaser-2026-s1 cohort tests (issue #79).
//
// Used by 06/07/08 spec files. Hit wrangler dev directly (no .app required for
// T1.A profile-shape and T2.* LLM-shape tests).

import * as fs from "node:fs";
import { TOKEN_FILE } from "./global-setup";

export const WORKER_URL = "http://localhost:8787";

export function readToken(): string {
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
}

export interface DentalProfile {
  profile_id: string;
  display_name: string;
  language: string;
  welcome: {
    greeting_md: string;
    example_prompts: string[];
  };
  ux: {
    coach: {
      naming_mode: string;
      fallback_name: string;
      naming_prompt_md: string;
      personality_prompt_md: string;
      revisit_on_entry?: boolean;
    };
    suggestions: {
      initial: Array<{ text: string; style: "good" | "weak"; caption?: string }>;
      follow_up: Array<{ text: string; style: "good" | "weak"; caption?: string }>;
    };
    hints: {
      short_input: { enabled: boolean; min_chars: number; message_md: string };
      roll_input_button: { enabled: boolean; label: string; probe_md: string };
    };
    retry_button: { enabled: boolean; show_counter: boolean };
  };
  // Top-level fields the API echoes back (subset of internal Profile schema):
  essences_focus?: number[];
  audience?: { language: string; parent_coaching: boolean };
  publishing?: { enabled: boolean; strategy: string };
}

export async function fetchDentalProfile(): Promise<DentalProfile> {
  const token = readToken();
  const res = await fetch(`${WORKER_URL}/v1/profile`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET /v1/profile failed: ${res.status} ${body}`);
  }
  return (await res.json()) as DentalProfile;
}

export interface ChatTurnOptions {
  /** Optional system override is NOT allowed — the worker injects per-cohort prompt. */
  user: string;
  /** Max tokens for the assistant turn. Keep small for cost/flake control. */
  max_tokens?: number;
  /** Default false — non-streamed is easier for shape assertions. */
  stream?: boolean;
}

export interface ChatTurnResult {
  text: string;
  status: number;
  raw: any;
}

/**
 * Single non-streamed chat turn against /v1/chat/completions, returning the
 * assistant message text concatenated. Use sparingly in Tier 2 tests — each
 * call is real LLM cost.
 */
export async function sendChatTurn(opts: ChatTurnOptions): Promise<ChatTurnResult> {
  const token = readToken();
  const body = {
    model: "hypeproof-default",
    stream: opts.stream ?? false,
    max_tokens: opts.max_tokens ?? 300,
    messages: [{ role: "user", content: opts.user }],
  };
  const res = await fetch(`${WORKER_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const status = res.status;
  if (!res.ok) {
    const txt = await res.text();
    return { text: "", status, raw: txt };
  }

  if (opts.stream) {
    // SSE — concatenate delta content. Simple parse (no token splitting).
    const buf = await res.text();
    const lines = buf.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
    let acc = "";
    for (const line of lines) {
      try {
        const chunk = JSON.parse(line.slice(6));
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string") acc += delta;
      } catch {
        // ignore parse errors
      }
    }
    return { text: acc, status, raw: buf };
  }

  const json = (await res.json()) as any;
  const text =
    json.choices?.[0]?.message?.content ??
    json.choices?.[0]?.text ??
    "";
  return { text, status, raw: json };
}

/** Hangul char ratio (excluding whitespace). For language-shape assertions. */
export function hangulRatio(s: string): number {
  const compact = s.replace(/\s/g, "");
  if (compact.length === 0) return 0;
  let hangul = 0;
  for (const ch of compact) {
    const code = ch.codePointAt(0) ?? 0;
    // Hangul syllables + jamo + compat jamo
    if (
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f)
    ) {
      hangul++;
    }
  }
  return hangul / compact.length;
}

/** Try a Tier-2 assertion up to N times; pass if ≥ minPasses of N succeed. */
export async function retryAssertion<T>(
  fn: () => Promise<T>,
  check: (result: T) => boolean,
  opts: { tries?: number; minPasses?: number } = {},
): Promise<{ passed: boolean; results: T[]; passCount: number }> {
  const tries = opts.tries ?? 3;
  const minPasses = opts.minPasses ?? 2;
  const results: T[] = [];
  let passCount = 0;
  for (let i = 0; i < tries; i++) {
    const r = await fn();
    results.push(r);
    if (check(r)) passCount++;
  }
  return { passed: passCount >= minPasses, results, passCount };
}
