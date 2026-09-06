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
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const exactKeys = (x: Record<string, unknown>, keys: string[]) =>
  Object.keys(x).every((k) => keys.includes(k)) && keys.every((k) => k in x);
const text = (x: unknown, max: number) => typeof x === "string" && x.length <= max && !x.includes("\0");

export function validateSessionDesign(value: unknown, complete = false): string | null {
  if (!isObject(value) || !exactKeys(value, ["schema", "title", "audience", "duration_minutes", "objective", "prerequisites", "starter", "steps"])) return "invalid session-design fields";
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
  return null;
}
