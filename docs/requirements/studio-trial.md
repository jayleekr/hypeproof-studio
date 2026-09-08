# Public trial evidence contract

> 작성일 2026-09-08 · 상태: 초안

Product intent and UX requirements are delegated to `jayleekr/hypeprooflab:products/studio-trial/intent.md`, `design.md`, `requirements.md` (issue jayleekr/hypeprooflab#753). This repository implements R-04~09, R-15, R-17~18; it does not declare customer calibration complete.

`REQ-STUDIO-TRIAL-EVIDENCE`: `hps-trial/1` curriculum plus version-matched structured session produces seven evidence summaries with item/choice provenance. Unknown evidence remains null; coaching never raises independent level; duplicate or malformed observations throw; first and new tasks remain separate. Levels 4/5 require actual work evidence beyond this static trial and cannot be awarded here.

Layer declaration: curriculum data under docs/curriculum/studio-trial is Module; evaluation policy is a portable Service library under worker/src/lib. Lab is the public browser consumer. No HTTP route, authentication, telemetry, production retention, cohort or desktop binary changes are included.

One data contract: `hps-trial/1`, represented by Curriculum and TrialSession in trial-evidence.ts. This is not hps-module/1 system_prompt or session-design content. The new contract is statically exported to Lab with pinned commit and byte hashes by worker/scripts/export-trial.mjs. Exported files are generated consumer copies. Roll out source and consumer PRs together; update the manifest only when the source SHA is available.

Drift lock: `worker/test/trial-evidence.test.mjs` through `npm run test:trial`; Lab hash/contract test checks the consumed copy. Source contract tests include known positive and negative fixtures. These tests verify programmed conditions, not construct validity across occupations.

Exit plan: remove the Lab trial route and its generated copy, remove the export script, evaluation library, curriculum directory and test:trial script/test from Studio, then remove the trial registry entry. No participant records, deployed routes or tokens need migration. Existing HAIN7 and classroom remain independent.

Measurement limitation: browser choices can be edited by the visitor; they are explanatory self-exploration records, not trusted certification. Structured choices cannot establish actual AI tool operation. Actual customer understanding, completion time and level comprehension require a separate observed pilot.
