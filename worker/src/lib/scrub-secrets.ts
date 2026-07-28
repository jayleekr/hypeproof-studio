// Credential scrubbing for tool output on its way to the provider (epic #431).
//
// WHY SERVER-SIDE. The coach's Bash tool runs in the participant's extension
// host and its stdout comes back as a `tool_result` block on the NEXT turn's
// messages array. That array is prompt content: it reaches the provider, and it
// reaches our logs. One approved `cat ~/.git-credentials`, `env`, or a wrangler
// error echoing its token is enough to put a live credential in both.
//
// The extension has a twin (`extensions/hypeproof-chat/src/shellPolicy.ts`)
// covering a DIFFERENT surface — the command string shown in the approval modal
// and the activity log, i.e. what lands on the projector. Neither replaces the
// other, and this one is the authoritative half: it cannot be bypassed by an
// old or modified client.
//
// Over-masking is the acceptable failure direction. A coach that sees
// «GITHUB_TOKEN 가려짐» can still reason about the shape of a failure; a coach
// that sees the real token has already leaked it.

const SECRET_PATTERNS: readonly { re: RegExp; label: string }[] = [
  { re: /\bghp_[A-Za-z0-9]{20,}/g, label: "GITHUB_TOKEN" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, label: "GITHUB_TOKEN" },
  { re: /\bgh[ousr]_[A-Za-z0-9]{20,}/g, label: "GITHUB_TOKEN" },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, label: "ANTHROPIC_KEY" },
  { re: /\bsk-[A-Za-z0-9]{20,}/g, label: "API_KEY" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS_KEY" },
  { re: /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, label: "URL_CREDENTIALS" },
  { re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, label: "HYPEPROOF_TOKEN" },
  {
    re: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL)S?)\s*[=:]\s*["']?[^\s"'&]{8,}/gi,
    label: "SECRET_ASSIGNMENT",
  },
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    label: "PRIVATE_KEY",
  },
];

/** Mask credentials in a single string. */
export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re, label } of SECRET_PATTERNS) {
    if (label === "SECRET_ASSIGNMENT") {
      out = out.replace(re, (_m, key: string) => `${key}=«${label} 가려짐»`);
      continue;
    }
    if (label === "URL_CREDENTIALS") {
      out = out.replace(re, (_m, scheme: string) => `${scheme}«${label} 가려짐»@`);
      continue;
    }
    out = out.replace(re, `«${label} 가려짐»`);
  }
  return out;
}

/**
 * Scrub every `tool_result` block in an Anthropic-shaped messages array.
 *
 * Deliberately scoped to tool_result and NOT to user prose. Command output is
 * machine text where masking is harmless; a participant's own message is text
 * they wrote and expect back verbatim, and mangling it would be a worse bug
 * than the one being prevented. (If pasted-credential-in-chat becomes a real
 * problem, that is a separate, separately-tested decision.)
 *
 * Pure and total: anything that is not the expected shape is returned
 * unchanged, so a provider-side format change degrades to "no scrubbing"
 * rather than to a 500 on the classroom's hot path.
 */
export function scrubToolResultSecrets(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    const msg = m as { content?: unknown };
    if (!Array.isArray(msg.content)) return m;

    let touched = false;
    const content = msg.content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as { type?: unknown; content?: unknown };
      if (b.type !== "tool_result") return block;

      // tool_result.content is either a bare string or an array of blocks.
      if (typeof b.content === "string") {
        const scrubbed = scrubSecrets(b.content);
        if (scrubbed === b.content) return block;
        touched = true;
        return { ...b, content: scrubbed };
      }
      if (Array.isArray(b.content)) {
        let innerTouched = false;
        const inner = b.content.map((ib) => {
          if (!ib || typeof ib !== "object") return ib;
          const t = ib as { type?: unknown; text?: unknown };
          if (t.type !== "text" || typeof t.text !== "string") return ib;
          const scrubbed = scrubSecrets(t.text);
          if (scrubbed === t.text) return ib;
          innerTouched = true;
          return { ...t, text: scrubbed };
        });
        if (!innerTouched) return block;
        touched = true;
        return { ...b, content: inner };
      }
      return block;
    });

    return touched ? { ...msg, content } : m;
  });
}
