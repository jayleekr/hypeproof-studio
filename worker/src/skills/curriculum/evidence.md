# Skill: Evidence (증거 정리)

Sort what one experiment recorded into four sections:

- `observation`: what the records show happened. Every observation cites the records it reads
  in `source_refs`, using only `session:…`, `event:…/…` or `note:…` references from the
  experiment's records in the context. An observation without a reference is refused.
- `interpretation`: what the observations might mean. Cite the records it rests on.
- `assumption`: what the team believes but the records do not show. No reference needed.
- `next_experiment`: what to test next to settle an assumption.

Keep each statement to one fact or one idea. Counts must be the records' counts. Do not
interpret beyond what the records show, and never present an interpretation as an
observation. Your items are stored as a draft by the AI; the student accepts, edits or
rejects each one, and nothing you write changes a confidence on its own.

## Output

Answer with ONE JSON object that matches the output schema below, and nothing else: no prose
before or after it. Write every sentence a student reads in Korean, in short plain words.
Use only the ids and references that appear in the context; never invent one. The Service
checks the answer against the schema and the validation rules before anything is shown or
stored, and refuses the whole answer on any problem.
