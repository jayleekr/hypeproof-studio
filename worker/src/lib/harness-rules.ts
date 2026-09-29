// Cohort-harness rules, read by the worker (dag task H, attempt 2).
//
// `scripts/cohort-harness/rules.yaml` is the source of truth for the cohort
// guardrails; `validate.py` enforces them in CI on the COMPILED profiles
// (`npm run validate-profiles`, a required job). One of those rules,
// `child_missing_url_ban`, asserts on the PROMPT TEXT — a child cohort's
// system_prompt must contain `child.required_prompt_phrase` — and prompt text
// is exactly what task H made runtime-loadable. A module published to KV never
// meets CI, so the assertion has to travel with the text to the serve side.
//
// This file makes the worker DERIVE that requirement from rules.yaml rather
// than carry a second copy of the phrase. The yaml is bundled as text
// (wrangler.toml `[[rules]] type="Text"` now includes `**/*.yaml`) and parsed
// with a line-for-line port of validate.py's `parse_rules_yaml` — the same
// constrained subset (nested maps, scalars, lists of scalars, 2-space indent,
// full-line comments only). The port is itself drift-locked:
// test/module-child-guard.test.mjs runs validate.py's parser on the same file
// and asserts the two readers agree on the `child` block, and that the two
// sides reach the same verdict on a stripped profile.
//
// Classification mirrors validate.py exactly ("a cohort is child when
// audience.parent_coaching is true OR age_range max ≤ thresholds.child_age_max
// [default 12]"). It is deliberately NOT `isMinorCohort()` from moderation.ts
// (flag OR age < 18): that predicate drives moderation, this one drives the
// harness rule, and "what the harness would classify as a child cohort" is the
// contract being carried. A profile that is minor-for-moderation but not
// child-for-the-harness gets no phrase requirement — same as CI today.

// @ts-ignore — text import via the wrangler Text rule (test loader mirrors it)
import rulesYamlText from "../../scripts/cohort-harness/rules.yaml";
import type { Profile } from "../profiles/types";

type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };
type YamlMap = { [k: string]: YamlValue };

/** Port of validate.py `_scalar`. */
function scalar(value: string): YamlValue {
  value = value.trim();
  if (!value) return "";
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1);
  }
  const low = value.toLowerCase();
  if (low === "true") return true;
  if (low === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

/** Port of validate.py `parse_rules_yaml` — same subset, same quirks. */
export function parseRulesYaml(text: string): YamlMap {
  const lines: Array<[number, string]> = [];
  for (const raw of text.split("\n")) {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const indent = raw.length - raw.replace(/^ +/, "").length;
    lines.push([indent, stripped]);
  }
  let pos = 0;
  const parseBlock = (indent: number): YamlValue => {
    if (pos < lines.length && lines[pos]![1].startsWith("- ")) {
      const items: YamlValue[] = [];
      while (pos < lines.length && lines[pos]![0] === indent && lines[pos]![1].startsWith("- ")) {
        items.push(scalar(lines[pos]![1].slice(2)));
        pos++;
      }
      return items;
    }
    const block: YamlMap = {};
    while (pos < lines.length && lines[pos]![0] === indent && !lines[pos]![1].startsWith("- ")) {
      const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(lines[pos]![1]);
      if (!m) {
        pos++;
        continue;
      }
      const key = m[1]!;
      const rest = m[2]!;
      if (rest !== "") {
        block[key] = scalar(rest);
        pos++;
      } else {
        pos++;
        if (pos < lines.length && lines[pos]![0] > indent) {
          block[key] = parseBlock(lines[pos]![0]);
        } else {
          block[key] = null;
        }
      }
    }
    return block;
  };
  if (lines.length === 0) return {};
  const out = parseBlock(lines[0]![0]);
  return (out && typeof out === "object" && !Array.isArray(out) ? out : {}) as YamlMap;
}

export interface HarnessRules {
  /** rules.yaml `child:` block, verbatim as validate.py sees it (null if absent). */
  child: YamlMap | null;
  /** rules.yaml `thresholds.child_age_max` (null if absent → validate.py defaults to 12). */
  child_age_max: number | null;
  /**
   * Dotted paths from rules.yaml `required_keys` that are absent or empty
   * (#692). Non-empty means a guardrail was DELETED from the file, which every
   * reader would otherwise report as "nothing required". Port of validate.py's
   * `missing_required_keys`, including the code-level assertion that the
   * `required_keys` block itself exists.
   */
  missing_keys: string[];
}

/** Port of validate.py `dotted_get`, over the parsed rules map. */
function dottedGet(obj: YamlValue | undefined, path: string): YamlValue | undefined {
  let cur: YamlValue | undefined = obj;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur) || !(part in cur)) return undefined;
    cur = (cur as YamlMap)[part];
  }
  return cur;
}

/** Port of validate.py `missing_required_keys`. */
export function missingRequiredKeys(rules: YamlMap): string[] {
  const declared = rules.required_keys;
  if (!Array.isArray(declared) || declared.length === 0) return ["required_keys"];
  const missing: string[] = [];
  for (const path of declared) {
    if (typeof path !== "string" || !path) continue;
    const value = dottedGet(rules, path);
    const empty =
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0) ||
      (!!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
    if (empty) missing.push(path);
  }
  return missing;
}

let memo: HarnessRules | null = null;

export function readHarnessRules(text: string = rulesYamlText as unknown as string): HarnessRules {
  if (memo && text === (rulesYamlText as unknown as string)) return memo;
  const r = parseRulesYaml(text);
  const child = r.child;
  const th = r.thresholds;
  const ageMax = th && typeof th === "object" && !Array.isArray(th) ? th.child_age_max : undefined;
  const out: HarnessRules = {
    child: child && typeof child === "object" && !Array.isArray(child) ? child : null,
    child_age_max: typeof ageMax === "number" ? ageMax : null,
    missing_keys: missingRequiredKeys(r),
  };
  if (text === (rulesYamlText as unknown as string)) memo = out;
  return out;
}

/** validate.py's `is_child`, verbatim. */
export function isChildCohortPerHarness(
  profile: Pick<Profile, "audience">,
  rules: HarnessRules = readHarnessRules(),
): boolean {
  const aud = profile.audience ?? ({} as Profile["audience"]);
  const ar = aud.age_range as unknown;
  const childMax = rules.child_age_max ?? 12;
  const parentCoaching = aud.parent_coaching === true;
  const arValid =
    Array.isArray(ar) &&
    ar.length === 2 &&
    ar.every((x) => typeof x === "number" && Number.isFinite(x));
  const ageSaysChild = arValid && (ar as number[])[1]! <= childMax;
  return parentCoaching || ageSaysChild;
}

export interface CurriculumRequirements {
  /** Phrases the served system_prompt MUST contain. Empty for non-child cohorts. */
  required_phrases: string[];
  /**
   * Set when rules.yaml itself lost a guardrail key (#692) for a cohort that
   * NEEDS one. No text can satisfy it: the module is rejected and the compiled
   * prompt is served instead. An unguarded child cohort fails closed rather
   * than serving a published module nothing checked.
   */
  rules_error?: string;
}

/**
 * What the harness would demand of this profile's prompt text. The only
 * text-level rule today is `child.required_prompt_phrase`; adding another to
 * rules.yaml means extending this function AND validate.py — the drift-lock
 * test is what makes forgetting one side fail.
 */
export function curriculumRequirementsFor(
  profile: Pick<Profile, "audience">,
  rules: HarnessRules = readHarnessRules(),
): CurriculumRequirements {
  if (!isChildCohortPerHarness(profile, rules)) return { required_phrases: [] };
  // #692 — for a child cohort, "the rule is gone" must not read as "the rule
  // is satisfied". Only the child-facing keys matter here; an unrelated
  // missing key is CI's problem, not a reason to stop serving children.
  const relevant = rules.missing_keys.filter((k) => k.startsWith("child.") || k === "required_keys");
  const phrase = rules.child?.required_prompt_phrase;
  const phraseOk = typeof phrase === "string" && phrase.length > 0;
  if (relevant.length > 0 || !phraseOk) {
    const lost = relevant.length > 0 ? relevant.join(", ") : "child.required_prompt_phrase";
    return {
      required_phrases: [],
      rules_error:
        `cohort-harness rules are incomplete for a child cohort (missing: ${lost}) — ` +
        `refusing to serve a published module the harness cannot check (#692)`,
    };
  }
  return { required_phrases: [phrase as string] };
}

/** First violated requirement as a reason string, or null when the text passes. */
export function checkCurriculumRequirements(text: string, req: CurriculumRequirements): string | null {
  if (req.rules_error) return req.rules_error;
  for (const phrase of req.required_phrases) {
    if (!text.includes(phrase)) {
      return (
        `content.system_prompt is missing required phrase ${JSON.stringify(phrase)} ` +
        `(cohort-harness rules.yaml child.required_prompt_phrase — child cohort, CI rule child_missing_url_ban)`
      );
    }
  }
  return null;
}
