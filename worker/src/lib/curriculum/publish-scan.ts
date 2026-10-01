// The publish scan for secrets (recon R4; CR-17, CR-T17). One scanner, two hosts: the App
// runs it on every file before anything is uploaded, and the Worker re-runs it on receipt,
// adding the signature check only it can do (`verifyHypeproof`).
//
// The list is its own superset of the three existing lists (MC-30 `SECRET_PATTERNS` in
// measurement-core/local-record.ts, `scrubSecrets` in lib/scrub-secrets.ts and its twin in
// extensions/hypeproof-chat/src/shellPolicy.ts), plus one pattern for every `LLMProvider`
// value (env.ts: gemini, anthropic, openai, glm) and for Supabase service keys. The existing
// lists are not changed (no MC-30 change). worker/test/cr-publish.test.mjs pins each pattern
// against a sample of the real format and checks the superset claim against the other lists.
//
// Token-shaped values are decoded, not refused on their shape (R4):
//   - a three-part JWT passes only as a Supabase anon key (payload iss "supabase", role "anon");
//   - a two-part HypeProof token passes only as an app token (role "app") bound to this
//     Project and this test origin (none can be minted before cr-gateway; the rule is in
//     place so the Worker's verdict and the App's agree when they arrive);
//   - anything else that matches refuses the publish.
// Over-refusal is the accepted direction: the refusal names the file, the line and the rule.
// Pure and environment-neutral (atob, TextDecoder): no node or Worker imports.

export type ScanRule =
  | "private_key"
  | "anthropic_key"
  | "openai_key"
  | "gemini_key"
  | "glm_key"
  | "supabase_secret_key"
  | "github_token"
  | "aws_access_key"
  | "url_credentials"
  | "bearer_token"
  | "secret_assignment"
  | "jwt"
  | "hypeproof_token";

export interface ScanHit {
  file: string;
  line: number;
  rule: ScanRule;
  /** Why a token-shaped value was refused (`service_role`, `student`, `issuer`, `undecodable`, …). */
  detail?: string;
}

/** The test origin and Project an app token would have to name to pass. */
export interface ScanContext {
  projectId: string;
  testOrigin: string | null;
}

interface Pattern {
  rule: ScanRule;
  re: RegExp;
  /** Group holding a value that is judged by the token rule when it is token-shaped. */
  valueGroup?: number;
  /** A match that is ordinary code, not a value (see `secret_assignment`). */
  skip?: (m: RegExpExecArray) => boolean;
}

/**
 * An unquoted value that is a JavaScript expression, not a literal: a member path or a call
 * (`document.querySelector(`, `Math.random(`, `process.env.API_KEY`). A login-form mockup or a
 * random-id helper is ordinary student code; a literal (quoted, or a bare env-file value such
 * as `API_KEY=abcdefghijkl`) is still refused.
 */
const EXPRESSION = /^[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)+\(?|\()$/;

// Order matters only for reporting; every pattern runs.
const PATTERNS: readonly Pattern[] = [
  { rule: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { rule: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  // OpenAI (and the scrubber's generic `sk-` rule). Not an `sk-ant-` key: that rule names it.
  { rule: "openai_key", re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  // Google AI Studio (Gemini) keys: "AIza" + 35 characters.
  { rule: "gemini_key", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  // Z.ai GLM keys: a 32-hex id and a secret joined by a dot.
  { rule: "glm_key", re: /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}(?![A-Za-z0-9])/g },
  { rule: "supabase_secret_key", re: /\bsb_secret_[A-Za-z0-9_-]{16,}/g },
  { rule: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { rule: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: "url_credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:[^\s/@'"`]+@/gi },
  { rule: "bearer_token", re: /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g, valueGroup: 1 },
  {
    rule: "secret_assignment",
    re: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL)S?)["']?\s*[=:]\s*(["'`]?)([^\s"'`&,;)]{8,})/gi,
    valueGroup: 3,
    skip: (m) => m[2] === "" && EXPRESSION.test(m[3] ?? ""),
  },
];

// Any JWT or HypeProof-token-shaped value: base64url JSON beginning `{"` → "eyJ".
const TOKEN_SHAPE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g;
const TOKEN_EXACT = /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?$/;

function b64uJson(part: string): Record<string, unknown> | null {
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The token rule (R4). Returns null when the value may be published, else the reason.
 * Decoding is all the App can do; the Worker additionally verifies a HypeProof token's
 * signature (`verifyHypeproof`), so a forged app token is refused there.
 */
export function judgeToken(value: string, ctx: ScanContext): string | null {
  const parts = value.split(".");
  if (parts.length === 3) {
    const payload = b64uJson(parts[1]!);
    if (!payload) return "undecodable";
    if (payload.iss === "supabase" && payload.role === "anon") return null;
    return payload.role === "service_role" ? "service_role" : "jwt";
  }
  if (parts.length === 2) {
    const payload = b64uJson(parts[0]!);
    if (!payload) return "undecodable";
    const role = payload.role;
    if (role === "issuer") return "issuer";
    if (role === undefined || role === "student") return "student";
    if (role !== "app") return `role:${String(role)}`;
    if (payload.project !== ctx.projectId) return "app_other_project";
    if (!ctx.testOrigin || payload.origin !== ctx.testOrigin) return "app_other_origin";
    return null;
  }
  return "undecodable";
}

export const isTokenShaped = (v: string): boolean => TOKEN_EXACT.test(v);

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Scan one file. `text` is the file decoded as UTF-8 (binary files too: a key inside an image
 * is still a key). Returns every hit; an empty list means the file may be published.
 */
export function scanFile(file: string, text: string, ctx: ScanContext): ScanHit[] {
  const hits: ScanHit[] = [];
  const judged = new Set<string>();
  const hit = (rule: ScanRule, index: number, detail?: string) => hits.push({ file, line: lineOf(text, index), rule, ...(detail ? { detail } : {}) });
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
      if (p.skip?.(m)) continue;
      const value = p.valueGroup ? m[p.valueGroup] : undefined;
      if (value && isTokenShaped(value)) {
        // A token-shaped value is judged by the token rule only, whatever pattern found it.
        judged.add(`${m.index + m[0].indexOf(value)}`);
        const why = judgeToken(value, ctx);
        if (why) hit(why === "student" || why === "issuer" || why.startsWith("app_") || why.startsWith("role:") ? "hypeproof_token" : "jwt", m.index, why);
        continue;
      }
      hit(p.rule, m.index);
    }
  }
  TOKEN_SHAPE.lastIndex = 0;
  for (let m = TOKEN_SHAPE.exec(text); m; m = TOKEN_SHAPE.exec(text)) {
    if (judged.has(`${m.index}`)) continue;
    const why = judgeToken(m[0], ctx);
    if (why) hit(m[0].split(".").length === 2 ? "hypeproof_token" : "jwt", m.index, why);
  }
  return hits.sort((a, b) => a.line - b.line);
}

/** Every two-part token-shaped value in a text, with its line (the Worker verifies each one's signature). */
export function hypeproofTokensIn(text: string): Array<{ value: string; line: number }> {
  const out: Array<{ value: string; line: number }> = [];
  TOKEN_SHAPE.lastIndex = 0;
  for (let m = TOKEN_SHAPE.exec(text); m; m = TOKEN_SHAPE.exec(text)) if (m[0].split(".").length === 2) out.push({ value: m[0], line: lineOf(text, m.index) });
  return out;
}

/** Student-facing words for a refused file. Names the file, the line and the rule. */
export function scanRefusalText(h: ScanHit): string {
  const what: Record<ScanRule, string> = {
    private_key: "개인 키",
    anthropic_key: "Anthropic API 키",
    openai_key: "OpenAI API 키",
    gemini_key: "Gemini API 키",
    glm_key: "GLM API 키",
    supabase_secret_key: "Supabase 비밀 키",
    github_token: "GitHub 토큰",
    aws_access_key: "AWS 키",
    url_credentials: "주소 안의 아이디·비밀번호",
    bearer_token: "인증 토큰",
    secret_assignment: "비밀값처럼 보이는 설정",
    jwt: h.detail === "service_role" ? "Supabase service_role 키" : "로그인 토큰(JWT)",
    hypeproof_token: h.detail === "issuer" ? "강사용 코드" : "참여 코드",
  };
  return `${h.file} ${h.line}번째 줄에 ${what[h.rule]}가 있어 공개하지 않았어요. 그 값을 지우거나 이름을 바꾼 뒤 다시 공개하세요. (${h.rule})`;
}
