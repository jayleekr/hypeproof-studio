// Chalk authoring content v1. Data only: never grants tools or stores credentials.
export interface SessionDesign {
  schema: "hps-session-design/1";
  title: string;
  audience: string;
  duration_minutes: number;
  objective: string;
  prerequisites: string;
  starter: string;
  steps: Array<{ id: string; title: string; instructions: string; hint: string; acceptance: string }>;
  /**
   * Optional lesson-level AI identity (#747 feature A). When present, the
   * Service projects `display_name` onto the served `ux.coach` as a fixed
   * name, so the Studio header and message labels show the instructor's name
   * for this frozen version only. It is display text: it never changes tool
   * grants, model policy, or the AI disclosure. Absent → the compiled
   * profile's ux.coach rule applies unchanged (old-schema behavior).
   */
  assistant?: { display_name: string };
}

/** Bounds for `assistant.display_name`: single line, trimmed, 1..40 chars. */
export const ASSISTANT_NAME_MAX = 40;

const REQUIRED_KEYS = ["schema", "title", "audience", "duration_minutes", "objective", "prerequisites", "starter", "steps"];
const OPTIONAL_KEYS = ["assistant"];
const ALLOWED_KEYS = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];

const isObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const exactKeys = (x: Record<string, unknown>, keys: string[]) =>
  Object.keys(x).every((k) => keys.includes(k)) && keys.every((k) => k in x);
// Required keys must all be present; optional keys may be absent; nothing else.
const allowKeys = (x: Record<string, unknown>, required: string[], allowed: string[]) =>
  Object.keys(x).every((k) => allowed.includes(k)) && required.every((k) => k in x);
const text = (x: unknown, max: number) => typeof x === "string" && x.length <= max && !x.includes("\0");

/**
 * A safe, single-line display name: no control characters (so it cannot break
 * a prompt line or a JSON envelope), no leading/trailing whitespace, bounded.
 * Markup characters are allowed; every renderer escapes text (React, Chalk's
 * textContent), so "<b>이름</b>" is rendered literally, never interpreted.
 */
export function validateAssistantName(value: unknown): string | null {
  if (typeof value !== "string") return "assistant.display_name must be a string";
  if (value !== value.trim()) return "assistant.display_name must not have surrounding whitespace";
  if (!value.length) return "assistant.display_name must not be empty";
  if (value.length > ASSISTANT_NAME_MAX) return `assistant.display_name must be at most ${ASSISTANT_NAME_MAX} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) return "assistant.display_name must be a single line without control characters";
  return null;
}

/** The lesson-level fixed AI name, or null when the lesson does not set one. */
export function lessonAssistantName(content: SessionDesign | null | undefined): string | null {
  const name = content?.assistant?.display_name;
  return typeof name === "string" && validateAssistantName(name) === null ? name : null;
}

export function validateSessionDesign(value: unknown, complete = false): string | null {
  if (!isObject(value) || !allowKeys(value, REQUIRED_KEYS, ALLOWED_KEYS)) return "invalid session-design fields";
  if (value.schema !== "hps-session-design/1") return "unsupported session-design schema";
  for (const k of ["title", "audience", "objective", "prerequisites", "starter"]) {
    if (!text(value[k], k === "title" ? 200 : 4000)) return `invalid ${k}`;
    if (complete && ["title", "audience", "objective", "starter"].includes(k) && !(value[k] as string).trim()) return `${k} is required to freeze a version`;
  }
  // Starter is a reference/description, not executable HTML or an uploaded archive.
  if (!Number.isInteger(value.duration_minutes) || (value.duration_minutes as number) < 1 || (value.duration_minutes as number) > 480) return "duration_minutes must be 1..480";
  if (!Array.isArray(value.steps) || value.steps.length > 30 || (complete && !value.steps.length)) return "steps must contain 1..30 items to freeze a version";
  const ids = new Set<string>();
  for (const step of value.steps) {
    if (!isObject(step) || !exactKeys(step, ["id", "title", "instructions", "hint", "acceptance"])) return "invalid step fields";
    if (typeof step.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(step.id) || ids.has(step.id)) return "step ids must be unique";
    ids.add(step.id);
    for (const k of ["title", "instructions", "hint", "acceptance"]) {
      if (!text(step[k], 8000)) return `invalid step ${step.id}.${k}`;
      if (complete && k !== "hint" && !(step[k] as string).trim()) return `step ${step.id}.${k} is required to freeze a version`;
    }
  }
  // Optional identity block: when present it must be exactly { display_name }.
  // An empty name is rejected rather than treated as "unset" — Chalk omits the
  // block instead, so a saved draft never carries an ambiguous blank.
  if ("assistant" in value) {
    if (!isObject(value.assistant) || !exactKeys(value.assistant, ["display_name"])) return "invalid assistant fields";
    const bad = validateAssistantName(value.assistant.display_name);
    if (bad) return bad;
  }
  return null;
}
