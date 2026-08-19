// Roster append + student token minting via the worker admin API.
//
// Reuses tests/rehearsal/helpers — zero new deps, same style.
// NOTE: importing rehearsal/helpers/env.mjs prints a "[rehearsal] env:" banner
// as an import side effect. It describes the REHEARSAL defaults (boah cohort),
// not this run. run.mjs prints its own banner right after; trust that one.

import { fetchJson } from "../rehearsal/helpers/api.mjs";
import { basicAuthHeader } from "../rehearsal/helpers/env.mjs";
import { readFileSync } from "node:fs";

/**
 * Read HPS_ADMIN_PASSWORD from worker/.dev.vars when it is not in the env.
 * The value is never printed — callers only ever see its length.
 */
export function adminPassword(devVarsPath) {
  if (process.env.HPS_ADMIN_PASSWORD) return process.env.HPS_ADMIN_PASSWORD;
  if (!devVarsPath) return "";
  try {
    const line = readFileSync(devVarsPath, "utf8")
      .split("\n")
      .find((l) => l.startsWith("HPS_ADMIN_PASSWORD="));
    if (!line) return "";
    return line.slice("HPS_ADMIN_PASSWORD=".length).trim().replace(/^["']|["']$/g, "");
  } catch {
    return "";
  }
}

export async function getCohortState(origin, password, cohortId) {
  const r = await fetchJson(`${origin}/admin/cohorts/${cohortId}/state`, {
    headers: { authorization: basicAuthHeader(password) },
    allowNon2xx: true,
  });
  return r;
}

/** Append users to the roster. Idempotent — already-present users are skipped. */
export async function appendRoster(origin, password, cohortId, users) {
  return fetchJson(`${origin}/admin/cohorts/${cohortId}/roster/append`, {
    method: "POST",
    headers: { authorization: basicAuthHeader(password) },
    body: { users },
    allowNon2xx: true,
  });
}

/**
 * Mint one student token.
 * hours: verification runs are long — 10-12h per .claude/rules/verification.md
 * ("검증은 길어지니 10~12시간짜리로 발급").
 */
export async function issueToken(origin, password, { user, cohort, profile, hours = 12 }) {
  const r = await fetchJson(`${origin}/admin/tokens/issue`, {
    method: "POST",
    headers: { authorization: basicAuthHeader(password) },
    body: { u: user, c: cohort, p: profile, hours },
    allowNon2xx: true,
  });
  if (r.status !== 200 || !r.json?.token) {
    throw new Error(`token issue failed for ${user}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  }
  return { token: r.json.token, jti: r.json.jti, user };
}

/**
 * Independently verify a token actually works BEFORE the load run starts.
 * verification.md rule 5 + "토큰을 의심하기 전에 토큰을 직접 찔러봐라".
 * Returns the /v1/profile body so the caller can assert coach_runtime etc.
 */
export async function probeToken(workerUrl, token) {
  const r = await fetchJson(`${workerUrl}/profile`, {
    headers: { authorization: `Bearer ${token}` },
    allowNon2xx: true,
  });
  return r;
}
