// #1421 — student-slot-first mode decision.
//
// Rule: if the student slot (TOKEN_KEY) holds an *active* workshop token,
// the student panel takes precedence over instructor mode.
// Instructor mode only opens when the student slot is empty or inactive.
//
// "Active" student token:
//   - token is present
//   - token exp (decoded without sig verify) has not passed
//   - last profile fetch did NOT end in a hard rejection (expired, rejected, forbidden)
//   - network/server failures keep the student active (transient outage must not
//     expose the instructor panel mid-class)

import { decodeTokenPayload } from "../mintStudentTokenHelpers.ts";

export type StudentProfileStatus =
  | "ok"          // last /v1/profile succeeded
  | "expired"     // 401 code=expired — hard inactive
  | "rejected"    // 401/403/400 other rejection — hard inactive
  | "unreachable" // network / 5xx — keep student-mode (transient)
  | null;         // token present but profile not yet fetched (app just launched,
                  // or token just pasted) — student mode while exp is valid

export type ModeDecisionInput = {
  studentToken: string | undefined;
  studentProfileStatus: StudentProfileStatus;
  now?: number; // seconds since epoch; defaults to Date.now() / 1000
};

export type PanelMode = "student" | "instructor";

/**
 * Decide whether to render the student or instructor panel.
 *
 * Student is preferred whenever the student slot holds an active token.
 * Instructor is only opened when the student slot is empty or inactive.
 */
export function decideMode(input: ModeDecisionInput): PanelMode {
  const { studentToken, studentProfileStatus } = input;
  const nowSec = input.now ?? Math.floor(Date.now() / 1000);

  // No student token → instructor may open.
  if (!studentToken) return "instructor";

  // Hard rejection: treat as inactive → instructor may open.
  if (studentProfileStatus === "expired" || studentProfileStatus === "rejected") {
    return "instructor";
  }

  // Token structurally expired (sig not checked): treat as inactive.
  const payload = decodeTokenPayload(studentToken);
  const exp = typeof payload?.exp === "number" ? payload.exp : undefined;
  if (exp !== undefined && exp < nowSec) return "instructor";

  // Token present + not hard-rejected + not structurally expired → student mode.
  // Covers: ok, unreachable, null (not yet fetched — must not flash instructor mid-class).
  return "student";
}

/**
 * Convert a ProfileFailure state to StudentProfileStatus for use in decideMode.
 *
 * profileFetched: true when ensureProfile() has completed at least once for the
 * current token (i.e., we have a real server answer). false/undefined = fetch
 * not yet attempted. This distinguishes "ok" (fetch completed, no failure) from
 * null (not yet fetched).
 */
export function profileFailureToStatus(
  failure: { reason: string } | null | undefined,
  hasToken: boolean,
  profileFetched: boolean,
): StudentProfileStatus {
  if (!hasToken) return null;
  if (!profileFetched || failure === undefined) return null; // not yet fetched
  if (failure === null) return "ok"; // fetch completed successfully
  switch (failure.reason) {
    case "expired":
      return "expired";
    case "rejected":
    case "forbidden":
    case "issuer_token":
    case "unknown_cohort":
      return "rejected";
    case "network":
    case "server":
      return "unreachable";
    default:
      return "unreachable";
  }
}
