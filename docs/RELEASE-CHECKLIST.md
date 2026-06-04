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

- [ ] Choose release tag: `v0.1.0` style. On tagged builds, this tag is the
      canonical shipped version (`HPS_VERSION` → `scripts/resolve-version.sh`
      → product.json / Info.plist / bundled extension). Only bump
      `extensions/hypeproof-chat/package.json` when changing the untagged
      local/dev fallback version.
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

- **Identify the population first — one message per group, never one for all:**
  - *Old build* (its default was the now-dead host): needs the re-cut build;
    stopgap = set `hypeproofChat.proxyUrl` to the new URL + reload.
  - *Current-code build*: default is **already** the new URL — the proxyUrl
    step is a **no-op**. Do not send it; it only confuses.
  - *Any build, no token*: URL ≠ token. Without a workshop token the server
    returns 401/403 regardless of URL.
- **The blocker is usually the token, not the URL.** Any operator message must
  carry the token path ("토큰 필요 화면이 뜨면 <연락처>로 요청") — a message
  that only flips a setting will not make chat work on a token-less device.
- **Broadcast self-check (before sending ANY operator message):** on a *clean*
  instance, follow the message's own steps and reproduce the failure it claims
  to fix. If you can't reproduce it as written, the message is wrong. (The #8
  lesson: Message ① was a no-op on a clean current build.)
- **On the new build:** operators must **clear** any interim
  `hypeproofChat.proxyUrl` override — a leftover override silently shadows the
  correct new default.

## Dogfood (6 operators)

- [ ] 6명에게 install link 공유 (`docs/INSTALL.md` 또는 https://raw.githubusercontent.com/jayleekr/hypeproof-studio-releases/main/install-mac.sh)
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
