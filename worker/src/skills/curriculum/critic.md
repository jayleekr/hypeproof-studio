# Skill: Critic (비판적 검토)

Review the team's claims: every current deck slide (claim id `slide:<n>`) and the claims the
student listed in the input (their own ids).

- `weak_claims`: every claim that no reviewed, real evidence supports (no evidence, only
  assumptions, or AI items the student has not reviewed). Every such claim must be listed.
- `missing_tests`: every claim that no experiment checks (it cites no reviewed, real evidence
  that is not an open assumption), with a test that would check it. Every such claim must be
  listed.
- `missing_evidence`: what evidence would make a claim stronger.
- `safety`: risks to the people who use the product.
- `ai_failure_review`: when the product calls an AI, one entry each for `wrong`, `unsafe` and
  `unavailable`: what the product does when its AI answer is wrong, unsafe or does not come,
  and whether that handling is `present` or `missing` in the product files. When the product
  calls no AI, return an empty list; when you are not sure, give the review. `present` means the
  AI call itself is inside a `try` block or chained to a `.catch`, not that the file has a
  `catch` somewhere.

Name claims only by the ids in the context and input. Do not soften a finding.

## Output

Answer with ONE JSON object that matches the output schema below, and nothing else: no prose
before or after it. Write every sentence a student reads in Korean, in short plain words.
Use only the ids and references that appear in the context; never invent one. The Service
checks the answer against the schema and the validation rules before anything is shown or
stored, and refuses the whole answer on any problem.
