# Methodology and evidence boundary

## Product claim

HAIN7 Studio Signal is a classroom **behavior-observation profile** inferred from a learner’s interaction trace and artifact history. It is not the formal HAIN7 adult assessment, an intelligence test, a personality test, a diagnosis, or proof of latent potential. Its appropriate claim is: “During this lesson, these seven execution-capability signals were observable to this degree.”

The formal HAIN7 fixed-item/micro-task/performance formula is not reused. Studio has no fixed questionnaire and its classroom tasks vary, so it uses four observable markers per axis, coverage reporting, and criterion bands.

## Why logs can be useful

- Evidence-centered design links a construct claim to observable evidence and then to the task that elicits it. ETS describes this claim-evidence-task logic for complex assessments: <https://www.ets.org/research/policy_research_reports/publications/report/2001/cmjw.html>
- OECD’s PISA process-data guidance notes that time-stamped action sequences can add validity and reliability evidence, while also warning that logs are noisy and cannot capture every relevant behavior: <https://www.oecd.org/content/dam/oecd/en/about/programmes/edu/pisa/publications/technical-report/pisa-2018-technical-report-files/PISA%202018%20Technical%20report%20-%20Annex%20K.pdf>
- A stealth-assessment study found game-trace estimates correlated with an external physics measure in 263 learners; this supports feasibility, not transfer of that study’s validity to HAIN7 Studio: <https://onlinelibrary.wiley.com/doi/10.1111/jcal.12473>
- A 2026 transcript-and-product rubric study reported high inter-rater reliability across three raters, but also stated that only visible transcript/product evidence can be credited and that single-site results limit generalization: <https://journals.sagepub.com/doi/pdf/10.1177/23821205261442106>

## Scoring quality controls

The implementation follows these controls:

1. observable 0 / 0.5 / 1 anchors rather than adjectives alone;
2. evidence IDs for every positive score;
3. `NA` for unavailable opportunity or telemetry;
4. separation of score, evidence coverage, and evidence confidence;
5. required 28-marker review for real reports;
6. versioned rubric and session fingerprint;
7. cohort comparison gates and explicit norm provenance.

ETS constructed-response guidance recommends explicit rubrics, exemplars, independent scoring, ongoing inter-rater agreement, and drift monitoring. Those become the production QA plan: double-score at least 20% of calibration records, calculate weighted kappa/ICC by axis, adjudicate disagreements, and retrain when drift exceeds the set threshold. Source: <https://www.ets.org/pdfs/about/cr_best_practices.pdf>

The Standards for Educational and Psychological Testing are the governing reference for validity, reliability, fairness, and intended-use claims: <https://www.testingstandards.net/>

## Child and AI safeguards

UNESCO’s student AI competency framework emphasizes human-centered judgment, ethics, and a progression from understanding to applying and creating. This is why the report rewards verification, bounded delegation, and retained human ownership—not prompt volume or AI polish: <https://www.unesco.org/en/articles/ai-competency-framework-students?hub=66973>

For Korean children under 14, the Personal Information Protection Act requires legal-guardian consent and verification, plus information presented in language the child can understand. The report pipeline therefore fails closed without consent metadata and a child-readable notice version: <https://www.law.go.kr/LSW/lsSideInfoP.do?docCls=jo&joBrNo=02&joNo=0022&lsiSeq=270351&urlMode=lsScJoRltInfoR>

Automated outputs must remain reviewable and contestable. Keep the analysis JSON, evidence pointers, rubric version, and reviewer record; provide a correction/deletion route. Relevant Korean privacy guidance: <https://www.pipc.go.kr/np/cop/bbs/selectBoardArticle.do?bbsId=BS217&mCode=G010030000&nttId=8161>

## Validation plan before commercial claims

1. **Content review:** 3–5 child-development/education/assessment experts map every marker to one HAIN7 construct and age-appropriate task opportunity.
2. **Cognitive labs:** 15–30 learners across grade bands; verify that prompts/actions mean what the rubric assumes.
3. **Rater study:** at least 100 sessions, two independent trained raters, weighted kappa/ICC per marker and axis; revise weak anchors.
4. **Generalization study:** multiple instructors, sites, curricula, durations, devices, and model versions; estimate task/instructor/tool effects.
5. **Fairness audit:** inspect language proficiency, disability/accessibility, prior coding exposure, and instructor scaffolding effects.
6. **External relation:** compare with independent performance tasks, not self-report alone.
7. **Norm release:** only after the validated-reference gate in `input-schema.md` passes. Freeze the rubric/task version and publish sample composition, uncertainty, and validity limits.

Until this plan is completed, sell the output as a coached learning snapshot and next-step guide—not a high-stakes selection or certification score.
