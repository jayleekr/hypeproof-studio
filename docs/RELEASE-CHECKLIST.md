# Release v0.1.0 — checklist

Use this before any release-cutting action. Source of truth for Phase 7 decision gate.

## Pre-cut

- [ ] All Phase decision gates passed (METAPLAN §10 status table updated)
- [ ] `scripts/check-env.sh` clean on dev machine
- [ ] Mac build: `bash scripts/build-all.sh` produces `HypeProof Studio.app`
- [ ] `bash scripts/verify-branding.sh` exits 0
- [ ] Manual smoke: open app → activity bar 💬 → set token → send "hello" → response streams
- [ ] Manual smoke: open app → request file write → modal appears → deny → no write
- [ ] Win CI: `gh workflow run build-windows.yml --ref main` → green
- [ ] Win artifact extracted on a real/VM Windows box → installer runs → app opens
- [ ] `announcements-extra.json` welcome message correct
- [ ] `docs/INSTALL.md` reviewed by 1 non-technical reader

## Cut

- [ ] Bump version: `extensions/hypeproof-chat/package.json` + product.json release tag
- [ ] `git tag v0.1.0 && git push --tags` → auto-triggers Win build
- [ ] Wait for Win artifact to land
- [ ] Zip Mac .app: `cd vscodium-base/VSCode-darwin-arm64 && zip -ry ../../dist/HypeProof-Studio-darwin-arm64.zip "HypeProof Studio.app"`
- [ ] Create GitHub Release v0.1.0:
  - Attach: `HypeProof-Studio-darwin-arm64.zip`, `HypeProof Studio Setup *.exe`, `HypeProof Studio-x64.zip`
  - Body: copy from RELEASE-NOTES below
- [ ] Verify one-line installers resolve to the new release (test from a fresh shell)

## Endpoint / config change → re-cut

When a shipped default changes (e.g. the `hypeproofChat.proxyUrl` host), every
distributed build is stale — run the full **Cut + Dogfood**, plus:

- **Interim, no rebuild:** operators set `hypeproofChat.proxyUrl` to the new
  URL (Settings → search `proxyUrl`) and reload. Unblocks them during the
  1–2 h build; announce in the operator chat the moment the Worker is live
  (`curl <api>/v1/health` → 200).
- **On the new build:** operators must **clear** that interim override before
  trusting the new default — a leftover override silently shadows it.

## Dogfood (6 operators)

- [ ] 6명에게 install link 공유 (`docs/INSTALL.md` 또는 https://hypeproof.ai/install)
- [ ] 6명 모두 install 성공 확인 (kakaotalk 단톡방)
- [ ] 6명 모두 token 등록 + 첫 메시지 응답 OK
- [ ] 발견된 이슈 → GitHub Issues 또는 hotfix v0.1.1
- [ ] (endpoint/config re-cut only) operators cleared any interim `hypeproofChat.proxyUrl` override

## Dry-run (1–2 자녀, 4시간)

- [ ] 게임 만들기 골든 path: "삼각형 게임 만들어줘" → 게임 미리보기 → 수정 요청
- [ ] 파일 쓰기 modal 동작 확인
- [ ] 4시간 세션 끝까지 conversation history 유지 확인
- [ ] 종료 후 피드백 수집 (오디오 또는 메모)

## Go / No-go (SK바이오팜 1회차)

다음이 **모두 true**이면 GO:
- [ ] 6 operator install rate = 100%
- [ ] Dogfood 0 P0 issue
- [ ] Dry-run 4h 완주
- [ ] Plan B trigger date (2026-05-28) 통과

## Post-launch

- [ ] 1회차 끝나고 24h 내 retro (참가자 + 운영진)
- [ ] v0.1.1 hotfix 후보 issue 분류
- [ ] METAPLAN §11 미해결 결정 업데이트
