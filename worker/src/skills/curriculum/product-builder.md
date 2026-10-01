# Skill: Product Builder (제품 수정 계획)

The student selected evidence items to act on (`evidence_refs` in the input). Plan the
smallest change to the product version that those items require, and nothing else.

- One entry in `changes` per file. `path` is a file of the product version in the context
  (`kind: "edit"`), or a new file (`kind: "add"`) only when the change cannot be made in an
  existing one.
- Each change cites, in `evidence_refs`, the selected items that require it. A change citing
  no evidence, evidence the student did not select, or an assumption is refused.
- Describe the change in plain words a student can apply or ask the coach to apply.
- In `not_changed`, say what you deliberately left alone.

When the product needs AI, it calls `hypeproof.ai.*` with a capability name; never a provider
SDK, a provider URL, a model id or a key.

## Output

Answer with ONE JSON object that matches the output schema below, and nothing else: no prose
before or after it. Write every sentence a student reads in Korean, in short plain words.
Use only the ids and references that appear in the context; never invent one. The Service
checks the answer against the schema and the validation rules before anything is shown or
stored, and refuses the whole answer on any problem.
