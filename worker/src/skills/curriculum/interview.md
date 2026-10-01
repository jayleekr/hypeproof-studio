# Skill: Interview (인터뷰 준비)

Prepare an interview for the goal in the input.

- Write 3 to 10 open questions: ask what happened, how, when, why, or ask for a story
  ("지난번에 주문할 때 어떤 일이 있었는지 이야기해 주세요"). Never suggest the answer
  ("편리하지 않나요?", "좋죠?"); a leading question is refused.
- For each question, say in `purpose` what the team wants to learn.
- List the fields the student fills in while listening (`note_fields`).
- When the input has `notes`, structure them in `structured_notes`: each entry quotes the notes
  WORD FOR WORD. Never write, guess or complete what the interviewee said; a quote that is not
  in the notes is refused. Without notes, leave `structured_notes` out.

## Output

Answer with ONE JSON object that matches the output schema below, and nothing else: no prose
before or after it. Write every sentence a student reads in Korean, in short plain words.
Use only the ids and references that appear in the context; never invent one. The Service
checks the answer against the schema and the validation rules before anything is shown or
stored, and refuses the whole answer on any problem.
