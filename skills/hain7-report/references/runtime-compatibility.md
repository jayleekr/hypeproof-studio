# Runtime compatibility

`hain7-report` is one canonical Agent Skills folder. Keep the scorer, rubric, examples, and references identical across runtimes; only discovery and invocation syntax differ.

## Supported layouts

| Runtime | Personal install | Invocation | Skill-directory resolution |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/skills/hain7-report/` | `/hain7-report` | `${CLAUDE_SKILL_DIR}` |
| Codex | `~/.codex/skills/hain7-report/` | `$hain7-report` | absolute path in available-skills metadata |
| Other Agent Skills runtimes | runtime-specific skill root | runtime-specific | parent directory of this `SKILL.md` |

Claude Code derives the slash-command name from the skill directory, discovers both project and personal skills, and exposes `${CLAUDE_SKILL_DIR}` for bundled resources. Codex uses the same `SKILL.md`; `agents/openai.yaml` supplies Codex UI metadata and is not part of scoring. Sources: [Claude Code skills](https://code.claude.com/docs/en/slash-commands), [Anthropic Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview).

## Portable execution contract

1. Resolve the absolute skill directory before running a command.
2. Run `<skill_dir>/scripts/hain7_signal.py`; never assume the shell starts inside the skill.
3. Keep the deterministic Python scorer, rubric version, session fingerprint, 28-marker review, and cohort gates unchanged across models.
4. Use the model only for rubric-anchored evidence review, explanation, and visual QA. Do not let a model invent scores outside the review JSON contract.
5. Detect Python, ReportLab, and a Korean font before PDF generation. Stop with a clear dependency error rather than silently using the network or changing the report engine.

Claude Code example:

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/hain7_signal.py" \
  --input /path/to/session \
  --context /path/to/report-context.json \
  --analysis-output /path/to/hain7-analysis.json
```

## Claude.ai and Claude API

The same folder can be packaged as a custom Agent Skill for Claude.ai or uploaded through Anthropic's Skills API. Do not add Claude-only prompts or fork the rubric. API-hosted custom skills require the code-execution tool and currently use the Skills API beta surface. Sources: [Skills guide](https://platform.claude.com/docs/en/build-with-claude/skills-guide), [managed-agent skills](https://platform.claude.com/docs/en/managed-agents/skills).

Anthropic documents that Agent Skills are not eligible for Zero Data Retention. Do not upload real child session logs to Claude.ai/API custom-skill storage until the organization has approved data retention, processor terms, guardian notice/consent, and deletion operations. Local script execution still does not make a hosted model local: any evidence the agent reads may be transmitted under that runtime's data policy.

## Release check

- folder name and frontmatter name are both `hain7-report`;
- Claude Code invocation is `/hain7-report`;
- Codex invocation is `$hain7-report`;
- every command resolves resources from the skill directory;
- `quick_validate.py` passes;
- scorer unit tests and the synthetic one-page PDF pass in the release environment.
