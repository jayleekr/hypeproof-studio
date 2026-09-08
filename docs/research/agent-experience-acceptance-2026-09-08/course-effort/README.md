# Course effort evidence — 2026-09-08

REQ-M40 / #799. Product code verified at `39f8b29`; exact commits, bundle digests,
Node/platform and Service source digest are in each environment.json. The later
commit adds this evidence only. All identities and lessons are synthetic; the
upstream is the real Anthropic API. This is not production-class validation.

| Run | Real API requests | Result |
|---|---:|---|
| [Agent SDK](agent-sdk/effort-result.json) | 22 | PASS: 9 models, 11 user turns including fixed course |
| [Proxy](proxy/effort-result.json) | 11 | PASS: same cases through the proxy runtime |
| [Untouched v0.1.56](old-client/old-client-result.json) | 2 | PASS: absent effort header receives frozen medium default |

All 35 calls returned HTTP 200. API request shape and D1 records are independently
compared; response text is not proof of the applied setting. Agent SDK emits an
additional request in these cases. The grouping waits for observed pending calls
and compares turn IDs, rather than assuming every late response belongs to the
next user turn. This is not a complete billing/attempt ledger (#800).

Real cases: Sonnet 4.6 low/high, Sonnet 5 medium, Opus 4.5 low, Opus 5 high,
Opus 4.6 medium, Opus 4.7 low, Opus 4.8 high, unsupported Haiku 4.5 and Sonnet 4.5,
and a second frozen course fixed to Sonnet 4.6 low. The Service mock/SQLite matrix
also covers all 9 models × both routes × absent/low/medium plus denied values,
fixed policy, duplicate persistence and cross-student/course denial. This does not
claim all three effort levels were live-tested on every model or verify every tool.

Both current-App runs use an isolated copy of the v0.1.56 Mac arm64 shell with the
candidate extension injected. The update banner on that development copy is not a
release result. The old-client control uses an unmodified v0.1.56 bundle. Production
state and the installed personal app were not changed. Execution cwd is the primary
clone's e2e directory. One isolated gateway ran at a time.

The agent opened all final PNGs retained here and visually checked them: current
App at 390 CSS px/200% and 1280px/100%, unsupported model detail, fixed model/effort,
Chalk at 390/1280px and the old client. The JSON's original visual_review=PENDING is
preserved as the runner output; this paragraph records the subsequent inspection.
The composer test now checks the Send button is inside the short viewport.

- [Student controls at 390px](agent-sdk/effort-390.png)
- [Fixed course and applied request settings](agent-sdk/fixed-course.png)
- [Unsupported model](agent-sdk/unsupported-model-record.png)
- [Instructor selection](chalk-effort-390.png)

Earlier failures are preserved in prior-runs: hidden-window screenshot timeout;
late auxiliary responses incorrectly grouped by array position; an alias absent
from the actual catalogue. A separate visual finding was the Send button being
pushed below a 200% viewport; collapsed-card spacing and scroll reachability were
fixed and the rerun explicitly verifies the button. Capturing the full Electron
window fixed the clipped zoom screenshot. Quiet runs remain offscreen/nonfocusable;
HPS_QUIET_NO_HIDE=1 avoids hidden-renderer capture stalls.

Windows actual-device tests, screen-reader speech, production migration, released
candidate App, instructor pilot, budget settlement and learning outcomes are NOT RUN.
The existing requirements for full release/production adoption remain in force.
SHA-256 of retained raw files is in sha256.json.
