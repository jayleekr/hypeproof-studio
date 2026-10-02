# Skill: Interview (인터뷰 준비)

Prepare an interview for the goal in the input.

- Write 3 to 10 open questions: ask what happened, how, when, why, or ask for a story
  ("지난번에 주문할 때 어떤 일이 있었는지 이야기해 주세요"). Never suggest the answer
  ("편리하지 않나요?", "좋죠?", "기존 것보다 나은가요?", "이 앱 덕분에…"); a leading question
  is refused.
- For each question, say in `purpose` what the team wants to learn as a short label of at most
  60 characters ("막힌 곳"), never a sentence or an answer.
- List the fields the student fills in while listening (`note_fields`): short labels of at most
  30 characters ("막힌 단계", "불편한 점"), never a sentence, a quote or an answer ("가격 비쌈",
  "혼자 주문 불가" are answers).
- When the input has `notes`, structure them in `structured_notes`: each entry's `topic` is one
  of your `note_fields`, word for word, and its `quote` quotes the notes WORD FOR WORD. Never write, guess or complete what the interviewee said; a quote that is not
  in the notes is refused. Without notes, leave `structured_notes` out.

## Output

Answer with ONE JSON object that matches the output schema below, and nothing else: no prose
before or after it. Write every sentence a student reads in Korean, in short plain words.
Use only the ids and references that appear in the context; never invent one. The Service
checks the answer against the schema and the validation rules before anything is shown or
stored, and refuses the whole answer on any problem.
