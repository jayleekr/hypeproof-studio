# HANDOFF-apply: 준비 문서를 새 worktree에 옮길 때 할 일

> 작성일 2026-09-18 · 상태: 활성 · 실행 세션이 `MASTER_PROMPT.md` §4 2단계에서 수행한다

## 왜 이 파일이 있나

준비 문서는 메인 체크아웃(`~/CodeWorkspace/hypeproof-studio`)에 썼는데, 그 체크아웃은 **`chore/work-ready-20260913` 브랜치이고 `origin/main`을 2026-09-15 이후 fetch하지 않았다.** `LocalReview.tsx`, `worker/src/lib/measurement-core/`처럼 main에는 있는 파일이 로컬에 없다. 그래서 준비 세션은 추적 파일(`config/traceability.json`, `docs/dev/04-requirements.md`, `docs/studio-requirements.md`)을 고치지 않고 아래에 적용할 내용을 남긴다.

**기반 검증은 끝냈다(2026-09-18).** 설계 문서가 읽은 worktree `.claude/worktrees/claude-1042`의 아홉 파일(`StartPage.tsx`, `startPage.ts`, `extension.ts`, `chatPanelProvider.ts`, `ChatPanel.tsx`, `LocalReview.tsx`, `assetStatusBar.ts`, `measurement-core/local-record.ts`, `session-design.ts`)을 GitHub API blob 해시로 `origin/main`과 대조했고 **아홉 개 모두 같다**(메인 체크아웃은 다섯 개가 다르다). 따라서 설계·요구·검증 문서의 코드 사실은 origin/main 기준이다. 그래도 구현 전에 새 worktree에서 해당 파일을 다시 연다(`.claude/rules/verification.md` 규칙 1).

## 1. 새 worktree로 옮길 untracked 파일 (그대로 복사)

```
docs/design/ui-philosophy-2026-09-18.md
docs/design/assets/ux-2026-09-18/            (docx 원본 + png 4장)
docs/design/ux-principles-breakdown-2026-09-18.md
docs/design/studio-learning-experience.md
docs/intents/studio-learning-experience.md
docs/requirements/studio-learning-experience.md
docs/testing/studio-learning-experience.md
docs/plan/studio-learning-experience.md
docs/plan/ux-dag.yaml
.claude/hypeproof/ux/                          (이 디렉터리 전체)
.claude/evals/STUDIO_UX_EVAL.md
```

`cp -R` 뒤 `git add`로 정확히 이 경로만 담는다.

## 2. `config/traceability.json`에 추가할 노드 (main 버전 위에)

**부모 ID는 main에 전부 있다고 확인했다(2026-09-18).** main의 레지스트리는 노드 126개이고 `ST-INT-NATIVE`, `ST-INT-MEASUREMENT-CORE`, `ST-REQ-MEASUREMENT-CORE`, `ST-REQ-LEARNING-AGENT-EXPERIENCE`, `ST-REQ-NATIVE`가 모두 있다. **로컬 체크아웃의 레지스트리는 79개뿐이라 이 부모 중 셋이 없다.** 준비 세션이 로컬에 노드를 넣지 않은 이유가 이것이다. 반드시 main 기준 파일 위에 넣는다. 그 뒤 `python3 scripts/hype-pr/pr.py inspect`.

파일을 쓸 때 포맷은 `json.dumps(d, ensure_ascii=False, indent=2) + "\n"`이다. main의 파일이 이 출력과 바이트 단위로 같음을 확인했으므로 공백 diff가 생기지 않는다.

```json
[
  {"id": "ST-INT-SX", "stage": "intent", "owner": "jayleekr",
   "depends_on": ["LAB-PRODUCT-ROLES", "ST-INT-NATIVE", "ST-INT-MEASUREMENT-CORE"],
   "sources": [{"path": "docs/intents/studio-learning-experience.md"},
               {"path": "docs/design/ux-principles-breakdown-2026-09-18.md"},
               {"path": "docs/design/ui-philosophy-2026-09-18.md"}]},
  {"id": "ST-REQ-SX", "stage": "requirement", "owner": "jayleekr",
   "depends_on": ["ST-INT-SX", "ST-REQ-MEASUREMENT-CORE", "ST-REQ-LEARNING-AGENT-EXPERIENCE", "ST-REQ-NATIVE"],
   "sources": [{"path": "docs/requirements/studio-learning-experience.md"}]},
  {"id": "ST-DES-SX", "stage": "design", "owner": "jayleekr",
   "depends_on": ["ST-REQ-SX"],
   "sources": [{"path": "docs/design/studio-learning-experience.md"},
               {"path": "docs/plan/studio-learning-experience.md"},
               {"path": "docs/plan/ux-dag.yaml"}]},
  {"id": "ST-TEST-SX", "stage": "test", "owner": "jayleekr",
   "depends_on": ["ST-REQ-SX", "ST-DES-SX"],
   "sources": [{"path": "docs/testing/studio-learning-experience.md"},
               {"path": ".claude/evals/STUDIO_UX_EVAL.md"}]}
]
```

구현 노드(`ST-IMP-SX-P0` 등)와 검증 노드(`ST-VAL-SX`)는 각 단계 PR에서 추가한다. `ST-VAL-SX`는 Jay의 실기 증거 파일이 생겼을 때만.

## 3. `docs/dev/04-requirements.md` 표에 추가할 행

```
| REQ-STUDIO-LEARNING-EXPERIENCE | learning-first UX (SX-01..60) | mission header and today's-work home, coach rail without answers, evidence drawer with completion and re-verification gates, boundary-only reflection, no score or badge on work screens, six-week content read from session design files | `docs/requirements/studio-learning-experience.md`, `extensions/hypeproof-chat/webview-ui/src/`, `worker/src/lib/measurement-core/`, `chalk/` |
```

## 4. `docs/studio-requirements.md` 맨 위(제목 다음)에 추가할 절

```
## Learning experience revision — 2026-09-18

`REQ-STUDIO-LEARNING-EXPERIENCE`: the student's default screen shows the current
task, customer and artifact; the coach asks and hints instead of answering;
evidence (criteria, reasons, before/after, real vs simulated) is captured in
the flow; reflection opens only at submit, session end and week end; no
capability score, level or badge appears on a work screen; six-week content is
session-design data, never code. Source: Jay's 2026-09-18 UI/UX design
philosophy. [Intent INT-SX-00–10](intents/studio-learning-experience.md),
[breakdown](design/ux-principles-breakdown-2026-09-18.md),
[SX-01–60 requirements](requirements/studio-learning-experience.md),
[design](design/studio-learning-experience.md),
[SX-T validation](testing/studio-learning-experience.md),
[plan and DAG](plan/studio-learning-experience.md).
Status: criteria proposed; implementation, runtime and human acceptance NOT RUN.
Overnight execution governance: `.claude/hypeproof/ux/`.
```

## 5. 옮긴 뒤 확인

- `docs/design/studio-learning-experience.md` "확인한 기반" 표의 파일 경로가 새 worktree에 실제로 있는지 `ls`로 확인하고, 없거나 다르면 표를 고치고 `STATE.md`에 적는다.
- `docs/testing/studio-learning-experience.md`가 이름 붙인 컴포넌트 파일이 있는지 확인한다.
- 첫 커밋: "docs(sx): 학습 경험 우선 Studio 요구사항·설계·검증·계획 (준비 문서 이관)".
