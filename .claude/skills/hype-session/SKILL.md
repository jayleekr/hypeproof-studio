---
name: hype-session
description: Open/close a HypeProof workshop session on the RIGHT track and bulk-issue student tokens via the worker admin API using the instructor's issuer token. Enforces explicit track confirmation (the 2026-07-18 incident opened the wrong track from a script default) and diagnoses stale-token 403s. Use when the user says "세션 열어줘", "수업 열어", "학생 토큰 줘", "세션 닫아줘", or asks what session is currently open. The web console at /console is the primary tool for instructors; this skill is the operator-side equivalent.
user_invocable: true
triggers:
  - "hype-session"
  - "세션 열어"
  - "세션 열어줘"
  - "수업 열어"
  - "세션 닫아"
  - "세션 상태"
  - "학생 토큰 발급"
  - "토큰 줘"
argument_hint: "[open <track> | close | status | tokens <names…>] — track은 생략 시 반드시 물어봄"
---

# hype-session

Instructor session ops using the issuer token at `~/.hypeproof/issuer-token`
(fallback: `HPS_ISSUER_TOKEN`). Two origins since plan task F split the
instructor surface into its own Worker:

- **writes** (session open/close, roster append, token mint) →
  `https://api.hypeproof-ai.xyz` (the Service)
- **reads** (`status`) → `https://chalk.hypeproof-ai.xyz` (Chalk; it also
  serves `/console`, which forwards the same writes to the Service)

The instructor-facing tool is the web console
(`https://chalk.hypeproof-ai.xyz/console`); this skill is for the operator
driving Claude Code.

## Iron rule: track is NEVER assumed

The 2026-07-18 incident: a script defaulted to the teaser track and the
wrong session opened. Therefore:

- If the user's request does not name a track (커리큘럼 이름으로), **ask
  which track before any mutation** — show the display names from the
  issuer scope, not profile IDs. e.g. boah-dental-2026-a:
  - `boah-dental-director-copyclone-2026-s1` — "원장 웹사이트 카피클론" (홈페이지 만들기)
  - `boah-dental-teaser-2026-s1` — "티저 · 원장님을 이겨라" (직원 검색엔진)
- Read-only actions (`status`) need no confirmation.

## Preflight (every invocation)

1. Read the issuer token; decode payload (`cut -d. -f1 | base64 -d`-style).
   Check `exp` (warn if < 7 days), `role === "issuer"`, and the scope for
   the target cohort (`can_start_session`, `max_session_hours`, `max_hours`,
   `profiles`).
2. A 403 with a token that looks fine usually means a **stale token file**
   (pre-#167 tokens lack `can_start_session`) — tell the user to get a
   reissue from Jay, don't retry blindly.

## Actions

### status
`GET https://chalk.hypeproof-ai.xyz/admin/cohorts/<cohort>/state` (issuer
Bearer, #352 — on Chalk, not the Service, since task F) → report session
(track display name + ends_at as KST), roster_size, paused. If paused, flag
loudly — students are blocked regardless of session.

### open <track> [hours, default 4 capped by max_session_hours]
1. Preflight + track confirmed (iron rule).
2. `status` first: if a live session exists, say what's open and confirm the
   switch (opening replaces it — one session per cohort).
3. `POST /admin/cohorts/<cohort>/session` with
   `{profile_id, starts_at: now, ends_at: now+Nh}` (ISO8601 UTC).
4. Report: track name, KST window, and remind that student tokens are per-
   profile — tokens minted for the OTHER track won't match this session.

### close
Confirm ("학생 채팅이 즉시 끊깁니다"), then
`DELETE /admin/cohorts/<cohort>/session`. Report what was ended.

### tokens <names…> [track] [hours, default 12 capped by max_hours]
Track confirmed (iron rule — must match the session being run). **Roster
first, then mint** (#367): `POST /admin/cohorts/<cohort>/roster/append`
`{users}` — the chat gate blocks any handle not in the roster
(`not_in_roster`), so a minted-but-unrostered token strands the student.
Then for each handle (lowercase, alnum+hyphen): `POST /admin/tokens/issue`
`{u, c, p, hours}`. Output one `name: token` block per student for easy
paste into KakaoTalk. Never write tokens to tracked files.

## Boundaries

- Issuer minting / scope widening is Jay's (admin) — if the scope lacks the
  cohort or `can_start_session`, stop and draft the request to Jay instead
  of trying workarounds.
- This skill mutates live workshop state. No bulk closes, no touching
  cohorts outside the issuer scope, no pause/unpause (admin-only).
- Don't paste the issuer token into chat output; refer to it by file path.
