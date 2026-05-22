# tests/rehearsal — HypeProof Studio workshop rehearsal smoke

Issue #83 의 cross-platform 운영 엣지케이스 테스트 번들.
**Node 22+ 만 있으면** PowerShell · cmd · Git Bash · macOS · Linux 어디서나 동일하게 동작.

## What's covered (5 categories, ~30 cases)

| 영역 | 파일 | 케이스 |
|---|---|---|
| R1 — Prod health & contract | `01-prod-health.test.mjs` | 5 |
| R2 — Token & session lifecycle | `02-token-lifecycle.test.mjs` | 6 |
| R3 — Coach behavior under stress | `03-coach-stress.test.mjs` | 8 |
| R4 — Issuer & mint edge | `04-issuer-mint.test.mjs` | 6 |
| R5 — Rate-limit & defense | `05-rate-limit.test.mjs` | 5 |

각 테스트는 필요한 환경변수가 없으면 **skip** 됩니다. 가지고 있는 토큰 종류에 맞춰 부분 실행해도 OK.

## Setup (3 steps)

### 1. Node 22+ 설치 — Win/Mac/Linux 동일

- Windows: <https://nodejs.org> LTS 다운로드 → 한 번 클릭
- macOS: `brew install node@22` 또는 nodejs.org installer
- Linux: 패키지 매니저로 (예: `apt install nodejs`)

확인: `node --version` → `v22.x.x` 출력되면 OK.

### 2. 이 디렉토리 위치 잡기

```
git clone https://github.com/jayleekr/hypeproof-studio.git
cd hypeproof-studio/tests/rehearsal
```

### 3. 환경변수 셋업 + `npm test`

**최소** (R1.1 health 만 verify): 환경변수 없이도 동작
```
npm test
```

**전형적** (cohort 토큰만): R1·R2·R3·R5 대부분 동작
```
PowerShell:
$env:TOKEN="eyJjIjoi..."
npm test

cmd:
set TOKEN=eyJjIjoi...
npm test

Bash:
TOKEN=eyJjIjoi... npm test
```

**완전** (admin + issuer 까지): 30 cases 전부 가능
```
PowerShell:
$env:WORKER_URL="https://api.hypeproof-ai.xyz/v1"
$env:TOKEN="<학생 토큰>"
$env:ADMIN_PASSWORD="<admin 비번>"
$env:ISSUER_TOKEN="<강사 issuer 토큰>"
npm test

Bash:
WORKER_URL=https://api.hypeproof-ai.xyz/v1 \
TOKEN=<학생 토큰> \
ADMIN_PASSWORD=<admin 비번> \
ISSUER_TOKEN=<강사 issuer 토큰> \
npm test
```

## Environment variables

| Var | Default | What's gated |
|---|---|---|
| `WORKER_URL` | `http://localhost:8787/v1` | All HTTP calls. Set to prod (`https://api.hypeproof-ai.xyz/v1`) for live smoke. |
| `TOKEN` | (empty) | R1.3–R1.5 (profile shape), R2.6 (gold-path chat), R3.* (coach stress), R5.* (rate-limit). |
| `ADMIN_PASSWORD` | (empty) | R1.2 (deep health), R2.4 (cohort pause). |
| `ISSUER_TOKEN` | (empty) | R4.1–R4.6 (issuer/mint edge). |
| `COHORT` | `boah-dental-2026-a` | Test target cohort. |
| `PROFILE` | `boah-dental-teaser-2026-s1` | Test target profile id. |

토큰이 없으면 관련 테스트가 자동으로 skip 됩니다 — 한 번에 가진 만큼만 돌리면 OK.

## Reading the output

`node --test` 출력은 표준 [TAP](https://testanything.org/) 형식:
- `ok N - desc` = pass
- `not ok N - desc` = fail (실패 detail 그 아래 inline)
- `# Subtest: filename.test.mjs` = 파일별 묶음
- 맨 끝 요약: `# tests N`, `# pass N`, `# fail N`, `# skipped N`

JUnit XML 결과 (CI 호환): `npm run test:junit` → `results.xml`

## What to do with failures

1. **Pass 가 아닌데 skip 도 아님** = 실제 문제. 출력에 어떤 단언이 깨졌는지 + 응답 본문 일부 포함됨.
2. 결과 (전체 출력 + 환경) Slack #hypeproof-studio 또는 Jay 한테 DM.
3. 워크숍 D-day 전에는 가능한 한 실제 prod (`WORKER_URL=https://api.hypeproof-ai.xyz/v1`) 로 한 번 더 돌려서 확인.

## English (TL;DR for non-Korean collaborators)

Cross-platform Node 22+ test bundle for HypeProof Studio workshop rehearsal.
Install Node 22+, set env vars (`TOKEN` minimum), run `npm test`. Tests
auto-skip when their required env vars are missing — run what you can. Output
is TAP; share `pass/fail/skipped` summary back to Jay. Five categories,
~30 cases, ~3 min runtime against a live worker. See the env table above
for what gates what.
