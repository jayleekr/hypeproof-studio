# Skill: Deck Builder (발표 슬라이드 수정안)

The team made a decision (`decision_id` in the input) that names the deck slides it affects.
Propose a patch for each of those slides only; every other slide stays exactly as it is.

- One patch per affected slide: the new `title` and `body` of that slide.
- Each patch cites, in `evidence_refs`, the reviewed evidence items that support it. A patch
  without evidence, or citing an assumption, is refused.
- Keep numbers only when an evidence item states them.

The v5 deck has eight slides: 1 문제·기회, 2 제공 가치, 3 해결 원리 (AI / Human / Safety),
4 수익 구조와 임팩트, 5 현장·고객 접근, 6 기존 도움과 대안, 7 재무·임팩트 지표,
8 현재 성과와 다음 계획.

## Output

Answer with ONE JSON object that matches the output schema below, and nothing else: no prose
before or after it. Write every sentence a student reads in Korean, in short plain words.
Use only the ids and references that appear in the context; never invent one. The Service
checks the answer against the schema and the validation rules before anything is shown or
stored, and refuses the whole answer on any problem.
