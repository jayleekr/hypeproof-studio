# JY dev 검수: 명령 한 줄로 PR 확인하기

화면이 들어가는 PR을 머지하기 전에 Dev 앱에서 직접 확인하는 절차 (PRD UX-05).

## 사용법

```bash
bash scripts/review-pr.sh <PR번호-또는-브랜치> [--provider claude|codex|service]
```

- `<PR번호-또는-브랜치>`: GitHub PR 번호 (예: `1302`) 또는 브랜치 이름
- `--provider`: Dev 앱의 AI 백엔드 연결 방식
  - `service` (기본값): 로컬 wrangler 서버(포트 8787)를 경유
  - `claude`: 로컬 Claude Code 구독 사용
  - `codex`: 로컬 Codex 구독 사용

## 동작 단계

| 단계 | 내용 | 전형적 소요 |
|---|---|---|
| 1 | PR 브랜치를 임시 worktree로 체크아웃 | ~3초 |
| 2 | 확장·webview-ui `npm ci` | ~3–5초(캐시 있음) / ~40–60초(첫 실행) |
| 3 | 임의 로컬 `.dev.vars` 생성 후 D1 초기화, `wrangler dev --port 8787` 기동 | ~25초(cold) |
| 4 | 로컬 테스트 강사 토큰 발급 및 클립보드 복사 | <1초 |
| 5 | `studio-dev.py run` — 확장 빌드·base app 패치·Dev 앱 실행 | ~15–30초 |
| 6 | 인앱 안내 출력 | — |

**Ctrl+C** 를 누르면 앱·서버·worktree를 자동 정리합니다.

## 사전 조건

- `/Applications/HypeProof Studio.app` 설치돼 있어야 함 (base app)
- `node`, `npm`, `npx wrangler`, `python3` 가 PATH에 있어야 함
- `gh` 로그인 돼 있어야 함 (PR 번호 모드 사용 시)

## 모델 연결

`--provider service`(기본값)로 실행하면 채팅이 로컬 wrangler 서버(포트 8787)를 경유합니다.
스크립트는 `.dev.vars`에 `ANTHROPIC_API_KEY`나 `ANTHROPIC_PROXY_URL`을 넣지 않습니다.
키가 없으면 실제 LLM 호출 시 502를 반환합니다 — 로컬 검수에서는 정상 동작입니다.

모의 모델로 채팅 흐름을 끝까지 돌리려면 서버를 띄우기 전에 `.dev.vars`의 `ANTHROPIC_PROXY_URL`을 로컬 가짜 서버로 둔다(T0-e 방식).

## 보안

- 매 실행마다 임의 서명 값(32자 hex)을 새로 생성 — 운영 `.dev.vars`를 복사하거나 심링크하지 않습니다.
- 포트 8787이 이미 점유돼 있으면 점유 프로세스 PID를 출력하고 즉시 종료합니다.
- 환경 변수에 운영 URL(`hypeproof-ai.xyz`)이 있으면 즉시 종료합니다.

## 문제 해결

| 증상 | 조치 |
|---|---|
| `port 8787 already in use` | 표시된 PID를 종료하거나 다른 세션을 닫는다 |
| 앱에서 `profile not permitted` | 자동 감지된 profile이 해당 PR의 cohort와 다를 수 있음 — `worker/src/profiles/` 직접 확인 |
| `Dependencies missing` | `npm ci`가 조용히 실패한 것 — 스크립트 재실행 |
| 토큰이 클립보드에 없음 | stdout에 출력된 토큰을 수동 복사 |
