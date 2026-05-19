# Runbook — 보아치과 HypeProof 티저 (2026-05-26, D-day)

운영자(비-Jay)가 당일 그대로 따라가는 단일 런북. 빌드/릴리스 메커니즘은
[RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md) · [../worker/DEPLOY.md](../worker/DEPLOY.md)
가 진실 소스 — 여기선 **이 행사 고유의 절차만**. 중복 금지.

| | |
|---|---|
| 행사 | 보아치과 HypeProof 티저 (성인, ~3h) |
| D-day | 2026-05-26 |
| cohort | `boah-dental-2026-a` |
| profile | `boah-dental-teaser-2026-s1` |

## 0. 누가 / 무엇을
운영자가 실행. 빌드는 안 함 — 프리빌드 `.app`을 받음 (Phase 5 빌드는 Jay, 5/23 — #18).

## 1. 선행 조건 (D-1까지 확인)
- [ ] SaaS 라이브: `curl -s https://api.hypeproof-ai.xyz/v1/health` → `{"ok":true,...}`
- [ ] **dental profile이 프로덕션에 배포됨** — `boah-dental-teaser-2026-s1`은 main에
      머지됐으나 prod Worker는 *마지막 배포 번들*을 돎. 강의 전 `worker/`에서
      `npx wrangler deploy` 1회 필요 (담당: Jay/재형, DEPLOY.md). **이게 안 되면
      §2가 fail 한다.**
- [ ] 빌트인 `.app` 준비 (Phase 5 게이트 #18, Jay 5/23) — 채팅 패널 active

## 2. D-1 사전 검증 (프로덕션 왕복)
```bash
cd worker
BASE_URL=https://api.hypeproof-ai.xyz \
  COHORT=boah-dental-2026-a PROFILE=boah-dental-teaser-2026-s1 \
  bash scripts/smoke-dental-e2e.sh
```
→ `═══ PASS ═══` 이어야 GO. (이 스크립트가 토큰발급→403→roster→session→200
한국어 응답까지 한 번에 검증 — #14.) FAIL이면 §5.

## 3. 토큰 배포
참가자 1인 1토큰. 운영자 머신에서:
```bash
cd worker
HPS_SIGNING_SECRET=<prod와 동일> node --experimental-strip-types \
  scripts/issue-token.ts --user <참가자핸들> \
  --cohort boah-dental-2026-a --profile boah-dental-teaser-2026-s1 --hours 6
```
- 발급한 `<참가자핸들>` 들을 §4의 roster에 **그대로** 넣어야 인가됨.
- 로컬 dev 시연이면 `bash scripts/dev-stack.sh` (cohort/profile env override —
  #15) 가 토큰을 `/tmp/hps-token.txt`에 써서 앱이 자동 임포트.

## 4. 당일 설치 + 세션 오픈
1. 참가자 설치 (원라이너):
   `curl -fsSL https://raw.githubusercontent.com/jayleekr/hypeproof-studio/main/scripts/install-mac.sh | bash`
   (현재 빌드 디폴트가 이미 `api.hypeproof-ai.xyz/v1` — proxyUrl 수동설정 불필요)
2. roster 등록 + 수업 세션 오픈 (운영자, admin):
   ```bash
   AUTH=$(printf ':%s' "<HPS_ADMIN_PASSWORD>" | base64)
   curl -fsS -X POST https://api.hypeproof-ai.xyz/admin/cohorts/boah-dental-2026-a/roster \
     -H "Authorization: Basic $AUTH" -H 'content-type: application/json' \
     -d '{"users":["참가자1","참가자2","..."]}'
   curl -fsS -X POST https://api.hypeproof-ai.xyz/admin/cohorts/boah-dental-2026-a/session \
     -H "Authorization: Basic $AUTH" -H 'content-type: application/json' \
     -d '{"profile_id":"boah-dental-teaser-2026-s1","starts_at":"<ISO now>","ends_at":"<ISO +4h>"}'
   ```
3. 참가자: 💬 → "HypeProof Chat: Set Workshop Token" → 본인 토큰 붙여넣기 → "안녕"

## 5. 폴백
| 증상 | 대응 |
|---|---|
| 채팅 403 | roster에 그 user 없음 / 세션 창 밖 → §4-2 roster·session 재확인 |
| 채팅 401 | 토큰 서명 불일치(서명키 prod≠발급) → prod `HPS_SIGNING_SECRET`로 재발급 |
| Gemini 503 / 끊김 | `gemini-2.5-flash` 고정 + 503 retry 이미 적용. 지속 시 잠깐 후 재시도 |
| profile not found | §1 — prod 미배포. `wrangler deploy` 후 §2 재실행 |
| 앱 Gatekeeper 경고 | install-mac.sh가 quarantine 해제함; 그래도 막히면 우클릭→열기 |
| 전면 불능 | 로컬 `dev-stack.sh` + curl 데모로 대체, 또는 재일정 (이 티저는 SK 1회차 Plan B(METAPLAN §9)와 무관) |

## 6. 수용 게이트 (이게 true면 성공)
- [ ] §2 프로덕션 스모크 PASS
- [ ] 참가자 전원 설치 성공
- [ ] 참가자 전원 토큰 등록 + "안녕" → 한국어 응답
- [ ] 4원칙(전심전력·만족유예·잇기·역목표)을 *직접 해봤다* 는 체험 확인 (#13)

## 참조 (중복 안 함)
- 빌드/릴리스: [RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md)
- Worker 배포/시크릿: [../worker/DEPLOY.md](../worker/DEPLOY.md)
- 스모크: `worker/scripts/smoke-dental-e2e.sh` (#14) · 로컬 스택: `scripts/dev-stack.sh` (#15)
- Plan B (SK 1회차 전용, 이 티저 아님): METAPLAN §9
