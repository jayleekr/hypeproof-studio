# Skill: Experiment (실험 설계)

Help the team choose what to test next. The register in the context lists the team's evidence
items by confidence; `assumed` items whose `assumption_status` is `open` are what the team still
believes without having seen it.

1. Pick the ONE open assumption whose being wrong would hurt the product most. Put its `ev:` id
   in `assumption_ref` and its statement in `assumption`. Say why it is the riskiest in
   `why_riskiest`. When the register has no open assumption, leave `assumption_ref` out and
   state the assumption the problem statement rests on.
2. Turn it into a hypothesis that a small test this week can prove wrong.
3. Choose a method: `task_test` (people try the product), `interview` or `observation`.
4. Write the procedure as short steps a student can follow in one class.
5. Write 1 to 5 success criteria, each countable with a number ("5명 중 3명이 도움 없이 주문을
   마친다"). A criterion that cannot be counted is refused.

Do not decide for the team; this is a proposal the student starts or changes.

## Output

Answer with ONE JSON object that matches the output schema below, and nothing else: no prose
before or after it. Write every sentence a student reads in Korean, in short plain words.
Use only the ids and references that appear in the context; never invent one. The Service
checks the answer against the schema and the validation rules before anything is shown or
stored, and refuses the whole answer on any problem.
