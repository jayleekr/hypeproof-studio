// Shell policy for the coach's Bash tool (epic #431). Pure + vscode-free so
// every rule here is locked by unit tests rather than by a lecture-day repro.
//
// DESIGN STANCE — deliberately NOT an allowlist.
//
// An earlier draft scoped shell to a prefix allowlist (`git`, `wrangler`, …).
// That was rejected for a reason worth recording: a narrow allowlist makes the
// coach INVENT detours when the task needs something off the list, which is the
// exact failure class as #428's fabricated `/app/workdir` — the model fills a
// gap it cannot fill honestly. Telling it the truth about what it can run
// removes the gap. So: any command may be proposed, and the APPROVAL MODAL is
// the gate. That mirrors how Claude Code itself works.
//
// What this module does provide, because "arbitrary commands" without it is
// just a footgun on the participant's real Mac (no container, no sandbox):
//
//   1. `isDestructiveCommand` — the small set that is unrecoverable when
//      approved by reflex. These get a stronger, never-remembered confirm.
//   2. `commandSignature` — the "always allow" key, so a participant approving
//      `git commit` fifteen times in the 20:35 block isn't trained to
//      rubber-stamp. Returns null whenever a command cannot be safely
//      summarized, which forces a fresh modal.
//   3. `scrubSecrets` — coach output travels through the gateway to the model.
//      A `cat ~/.git-credentials` would otherwise put a live PAT in the prompt.

/**
 * Shell metacharacters. Their presence means the string is not ONE command:
 * it chains, substitutes, pipes, or redirects. Such a command may still run
 * (the participant can approve it) but it can never be reduced to a stable
 * signature — `git status; rm -rf ~` must not be remembered as "git status".
 */
const SHELL_METACHARACTERS = /[;&|><`$(){}\n\r]/;

/**
 * Commands whose damage is not undoable by the participant in a workshop
 * setting. Matched on the RESOLVED command word, so `sudo rm` and a chained
 * `... && rm -rf ~` both land here.
 *
 * Deliberately short. This is not a security boundary — an approved shell can
 * do anything. It is a speed bump on the handful of verbs that turn a
 * mis-click into a lost afternoon (or a lost patient-records folder).
 */
const DESTRUCTIVE_COMMANDS = new Set([
  "rm", "rmdir", "shred", "unlink",
  "sudo", "su", "doas",
  "dd", "mkfs", "diskutil", "fdisk",
  "chmod", "chown", "chgrp",
  "kill", "killall", "pkill",
  "mv",
  "truncate",
  "launchctl", "systemctl",
  "defaults",
  "npm", "npx", "pnpm", "yarn",
]);

/**
 * Subcommand-level exceptions: the base command is on the destructive list for
 * its OTHER forms, but this particular form is routine in the curriculum.
 * `npm install` / `npx wrangler pages deploy` are the 20:35 block's bread and
 * butter — flagging them as destructive would make the strong confirm
 * meaningless through overuse, which is the failure we are trying to avoid.
 */
const DESTRUCTIVE_EXCEPTIONS = new Set([
  "npm install", "npm i", "npm ci", "npm run", "npm test", "npm list",
  "npx wrangler", "npx vite", "npx serve",
  "pnpm install", "pnpm run", "yarn install", "yarn run",
]);

/** Argument patterns that make an otherwise-ordinary command destructive. */
const DESTRUCTIVE_ARG_PATTERNS: readonly RegExp[] = [
  /\bgit\s+push\b[^\n]*\s(--force\b|-f\b)/,   // rewrites remote history
  /\bgit\s+reset\b[^\n]*\s--hard\b/,          // discards uncommitted work
  /\bgit\s+clean\b[^\n]*-[a-zA-Z]*[fd]/,      // deletes untracked files
  /\bgit\s+checkout\s+--\s/,                  // discards file changes
  /\bgit\s+branch\b[^\n]*\s-D\b/,
  // Output redirection, but ONLY the shape that can destroy the participant's
  // work: stdout to a path that is not scratch. Measured on a real run (#431
  // B5 verification): the naive `>` rule fired on 3 of 4 commands the coach
  // issued — `2>/dev/null`, `> /tmp/cf_tunnel.log 2>&1`. A strong confirm that
  // fires on noise-suppression is worse than none: it trains the reflex-approve
  // this whole gate exists to prevent.
  //
  //   NOT destructive:  2>/dev/null · 2>&1 · >/dev/null · > /tmp/x · >> file
  //   destructive:      > index.html · > ~/notes.md · 1> report.txt
  //   `1>` IS stdout (destructive); `2>`..`9>` are stderr/other fds; `>>` appends.
  /(?<![2-9&>])>(?!>)\s*(?!\/dev\/null|\/tmp\/|&)[^\s|&;]/,
  /\bcurl\b[^\n]*\|\s*(ba)?sh\b/,             // pipe-to-shell
  /\bwget\b[^\n]*\|\s*(ba)?sh\b/,
  /\bnpm\s+publish\b/,
];

/**
 * Words that INTRODUCE another command rather than being the command. Without
 * these, `ls | xargs rm -rf ~` reads as an `xargs` call and the `rm` hides one
 * word deeper — the exact shape a head-of-segment-only scan misses.
 */
const COMMAND_INTRODUCERS = new Set([
  "xargs", "env", "time", "nice", "nohup", "command", "exec", "builtin",
  "sh", "bash", "zsh", "dash", "-exec", "-execdir", "-c", "then", "else", "do",
]);

function commandWords(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Strip quoted runs so a commit MESSAGE mentioning "rm" isn't read as one. */
function stripQuoted(command: string): string {
  return command.replace(/'[^']*'/g, " '' ").replace(/"[^"]*"/g, ' "" ');
}

/** basename: `/bin/rm` → `rm`. */
function head(word: string): string {
  return word.replace(/^.*\//, "");
}

/**
 * Is this command one whose approval should NOT be remembered, and which
 * deserves a louder modal?
 *
 * Checks the command word of EVERY segment, because `git status && rm -rf ~`
 * is destructive even though it starts with `git`.
 */
export function isDestructiveCommand(command: string): boolean {
  if (!command || !command.trim()) return false;

  // Quoted text is data, not shell syntax: `git commit -m "rm the header"` must
  // not trip the scan. Strip quoted runs BEFORE anything else looks at the
  // string — including the arg patterns below.
  //
  // 이 순서가 실측으로 틀렸던 자리다(2026-07-27). 예전에는 arg 패턴을 **원본**에
  // 걸었고, 그래서 읽기 전용 명령이 파괴적으로 분류됐다:
  //
  //   curl -sL "<url>" | python3 -c "import re; print(re.sub(r'<[^>]+>','',s))"
  //                                                          ^^^ 여기 `>]` 를
  //   출력 리다이렉트(`> 파일`)로 읽었다. 파이썬 정규식의 일부일 뿐인데.
  //
  // 결과는 「항상 허용」이 없는 강한 확인이 매 호출마다 뜨는 것 — 승인 게이트가
  // 교육 장치가 아니라 잡음이 된다. 따옴표 안을 먼저 비우면 사라진다.
  //
  // 살균이 진짜 위험을 가리지는 않는다: `rm -rf "$HOME"` 은 따옴표를 비워도
  // `rm -rf` 가 남아 아래 단어 스캔에 걸리고, `> "my file.txt"` 는 `> ""` 가 되어
  // 리다이렉트 규칙에 그대로 걸린다.
  const scannable = stripQuoted(command);

  for (const pattern of DESTRUCTIVE_ARG_PATTERNS) {
    if (pattern.test(scannable)) return true;
  }

  // Each chaining operator (and each substitution) starts a NEW command, so
  // scan every segment — `git status && rm -rf ~` is destructive even though
  // it starts with git.
  for (const segment of scannable.split(/[;&|]+|\$\(|`|\n/)) {
    const words = commandWords(segment.replace(/^[\s()]+/, ""));
    // Walk the segment tracking whether the next word is in COMMAND position.
    // Flags are transparent; introducers (xargs, sh -c, find -exec) hand the
    // command position to the following word.
    let expectCommand = true;
    for (let i = 0; i < words.length; i++) {
      const word = head(words[i]);
      if (COMMAND_INTRODUCERS.has(word)) {
        expectCommand = true;
        continue;
      }
      if (word.startsWith("-")) continue; // flag — does not consume the slot
      if (!expectCommand) continue;

      if (DESTRUCTIVE_COMMANDS.has(word)) {
        // On the list for its other forms — is THIS form routine?
        const next = words[i + 1] ? head(words[i + 1]) : "";
        if (DESTRUCTIVE_EXCEPTIONS.has(`${word} ${next}`.trim())) {
          expectCommand = false;
          continue;
        }
        return true;
      }
      // An ordinary command word: everything after it is its arguments.
      expectCommand = false;
    }
  }
  return false;
}

/**
 * Stable key for "이 명령은 항상 허용" within a session.
 *
 * Returns null — meaning "always ask, never remember" — when the command
 * cannot be safely summarized:
 *   - it is destructive (approving `rm` once must not approve it forever);
 *   - it contains shell metacharacters (the signature would describe only the
 *     first segment while the rest runs unreviewed).
 *
 * Otherwise the signature is the command word plus its first subcommand, so
 * `git commit -m "초안"` and `git commit -m "루브릭 반영"` share one key. That
 * is the point: the 20:35 block commits repeatedly, and a participant asked to
 * approve fifteen near-identical modals stops reading them.
 */
export function commandSignature(command: string): string | null {
  const trimmed = (command ?? "").trim();
  if (!trimmed) return null;
  if (SHELL_METACHARACTERS.test(trimmed)) return null;
  if (isDestructiveCommand(trimmed)) return null;

  const words = commandWords(trimmed);
  const head = words[0].replace(/^.*\//, "");
  const second = words[1];
  // A bare flag ("-m") is not a subcommand; a word is.
  if (second && /^[A-Za-z0-9]/.test(second)) return `${head} ${second}`;
  return head;
}

/**
 * Reviewable command for the approval modal. Preserve the entire command and
 * line breaks: an operation in the middle matters as much as its first/last
 * word. Redact credentials before displaying it on a workshop projector.
 */
export function describeCommandForApproval(command: string): string {
  return scrubSecrets(command ?? "");
}

// ── Secret scrubbing ────────────────────────────────────────────────────────
// The coach's tool RESULTS are fed back into the model through the HypeProof
// gateway, so anything a command prints becomes prompt content and lands in
// logs. Without shell that was a non-issue; with it, `cat ~/.git-credentials`,
// `env`, or a wrangler error echoing its token are one approval away.

const SECRET_PATTERNS: readonly { re: RegExp; label: string }[] = [
  // GitHub — PAT (classic + fine-grained) and the OAuth/app token family.
  { re: /\bghp_[A-Za-z0-9]{20,}/g, label: "GITHUB_TOKEN" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, label: "GITHUB_TOKEN" },
  { re: /\bgh[ousr]_[A-Za-z0-9]{20,}/g, label: "GITHUB_TOKEN" },
  // Anthropic + generic OpenAI-style keys.
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, label: "ANTHROPIC_KEY" },
  { re: /\bsk-[A-Za-z0-9]{20,}/g, label: "API_KEY" },
  // AWS access key id.
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS_KEY" },
  // Credentials embedded in a URL — exactly what ~/.git-credentials holds.
  { re: /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, label: "URL_CREDENTIALS" },
  // A HypeProof workshop/issuer token (base64url payload "." signature).
  { re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, label: "HYPEPROOF_TOKEN" },
  // Any KEY=value / KEY: value where the key NAMES a secret. Catches
  // CLOUDFLARE_API_TOKEN, CF_API_KEY, GH_TOKEN, DB_PASSWORD, … without
  // needing a pattern per vendor.
  {
    re: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL)S?)\s*[=:]\s*["']?[^\s"'&]{8,}/gi,
    label: "SECRET_ASSIGNMENT",
  },
  // PEM private key blocks — replace the whole body, not just the header.
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    label: "PRIVATE_KEY",
  },
];

/**
 * Mask credentials in text that is about to travel to the model.
 *
 * Fail-safe by shape: each pattern replaces with a labeled placeholder, so the
 * coach can still reason about "there is a token here" without ever seeing it.
 * Over-masking is acceptable; under-masking leaks a live credential into a
 * prompt and a log line.
 */
export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re, label } of SECRET_PATTERNS) {
    // Preserve the assignment's key name so `GH_TOKEN=***` still reads as a
    // token assignment rather than an opaque blob.
    if (label === "SECRET_ASSIGNMENT") {
      out = out.replace(re, (_m, key) => `${key}=«${label} 가려짐»`);
      continue;
    }
    if (label === "URL_CREDENTIALS") {
      out = out.replace(re, (_m, scheme) => `${scheme}«${label} 가려짐»@`);
      continue;
    }
    out = out.replace(re, `«${label} 가려짐»`);
  }
  return out;
}

/** Did scrubbing actually remove anything? Used to warn in the activity log. */
export function containsSecret(text: string): boolean {
  return !!text && scrubSecrets(text) !== text;
}
