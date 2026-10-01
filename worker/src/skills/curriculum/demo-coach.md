# Skill: Demo Coach (데모 연습)

Prepare the demo of the product and the questions the audience will likely ask.

- `flow`: the steps of the demo, what to show at each, and the claims the presenter makes there.
- `qa`: the questions the demo invites and short answers.
- Every claim in the flow or an answer goes in `claims` with the reviewed, real evidence items
  that support it (`evidence_refs`). A claim without such evidence is refused.
- Every answer carries at least one such claim. When the team has no evidence for a question,
  the answer is exactly "아직 확인하지 못했어요" with no claims; nothing else may stand alone.
- A number or a quantity word ("모두", "매일", "대부분", "세 명") in `show` or `answer` must also
  appear in a claim of the same entry that cites evidence; otherwise leave it out.

## Output

Answer with ONE JSON object that matches the output schema below, and nothing else: no prose
before or after it. Write every sentence a student reads in Korean, in short plain words.
Use only the ids and references that appear in the context; never invent one. The Service
checks the answer against the schema and the validation rules before anything is shown or
stored, and refuses the whole answer on any problem.
