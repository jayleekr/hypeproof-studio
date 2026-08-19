# Input, privacy, and comparison schema

## Studio session input

The input session directory contains:

- `session.meta.json`: Studio session metadata. Identity fields are not printed.
- `events.jsonl`: append-only records. Supported evidence types are `prompt`, `response`, `workflow`, `artifact_snapshot`, and `turn_end`.

The evaluator credits only learner prompts, learner-originated workflow events, and learner/manual artifact actions. `response` and AI-origin artifact sources (`assistant_response`, `assistant_tool`, `prebuilt`) supply context and telemetry coverage but are not Ownership evidence.

## Required report context

```json
{
  "schema_version": "1.0",
  "synthetic": false,
  "participant": {
    "display_id": "KID-023",
    "pseudonymous": true,
    "age": 11,
    "grade_band": "초등 5-6"
  },
  "lesson": {
    "title": "나만의 미로 게임",
    "date": "2026-08-19",
    "duration_minutes": 90,
    "curriculum_id": "game-lab-v1",
    "task_version": "maze-v1",
    "duration_band": "80-100m",
    "tool_version": "hp-studio-2026.8",
    "language": "ko"
  },
  "privacy": {
    "guardian_consent_verified": true,
    "guardian_consent_verified_at": "2026-08-18T10:00:00+09:00",
    "child_notice_version": "child-notice-2026-08",
    "purpose": "lesson_feedback",
    "correction_contact": "classroom-admin-id"
  }
}
```

Rules:

- `display_id` must be a pseudonym or class handle, not a real name. Real records must assert `pseudonymous: true` or the pipeline stops.
- Real records require age, grade band, lesson/task/tool versions, duration, purpose, notice version, and a correction route.
- Age under 14 additionally requires verified legal-guardian consent and its timestamp.
- `synthetic: true` bypasses consent checks but forces `DEMO DATA` on every output.
- No prompt text, real name, token, email, phone, or raw HTML is printed in the PDF.

## Cohort comparison input

```json
{
  "schema_version": "1.0",
  "kind": "local_same_condition",
  "synthetic": false,
  "label": "2026 여름 동일조건 코호트",
  "norm_key": {
    "grade_band": "초등 5-6",
    "curriculum_id": "game-lab-v1",
    "task_version": "maze-v1",
    "duration_band": "80-100m",
    "tool_version": "hp-studio-2026.8",
    "language": "ko"
  },
  "records": [
    {
      "participant_id": "anonymous-001",
      "scores": {"TA": 2.5, "IN": 3.0, "CO": 2.0, "VE": 2.5, "DE": 2.0, "IT": 2.5, "OW": 2.0}
    }
  ],
  "metadata": {
    "site_count": 1,
    "cohort_count": 1,
    "rubric_version": "hain7-studio-signal-1.0.0"
  }
}
```

### Local same-condition gate

All conditions must pass:

1. exact `norm_key` match on all six fields;
2. at least 30 complete, de-identified records;
3. seven finite scores from 0 to 4 per record;
4. same rubric version;
5. report labels the comparison “동일조건 코호트,” includes `n`, and states “국가규준 아님.”

Thirty is a product display floor, not proof of psychometric norm quality. Below it, suppress all relative claims and show criterion bands only.

### Validated-reference gate

For `kind: "validated_reference"`, require all local gates plus:

- at least 200 records in the matching stratum;
- at least 5 independent cohorts and 3 sites;
- per-axis reliability estimate at or above 0.75;
- documented fairness/bias audit passed;
- validity report URL/version and collection dates;
- frozen rubric, curriculum, task, and tool versions.

These thresholds are a conservative HypeProof release policy, not a universal scientific law. A qualified measurement specialist must approve any public “또래 백분위” or national-norm claim.

## Review input

Real reports require a review JSON with:

- exact `session_fingerprint` from the candidate analysis;
- `reviewer_type`, completion time, and all 28 `reviewed_marker_ids`;
- optional overrides using scores `0`, `0.5`, `1`, or `null`;
- evidence IDs that exist in the candidate analysis and a concise note.

The fingerprint prevents a review from being silently reused with different logs or context.
