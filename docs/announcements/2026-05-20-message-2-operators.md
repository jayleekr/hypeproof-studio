# Message ② — Operator 단톡방 공지

**보낼 곳**: 6명 operator 단톡방 (보아치과 1회차 워크숍 운영팀)
**보내는 시점**: 즉시 (D-6, 2026-05-20)
**Workshop**: 보아치과 teaser, D-day 2026-05-26

---

## 카톡 본문 (그대로 복붙)

```
[HypeProof Studio v0.1.0 배포 — 오퍼레이터 6명 설치 부탁드립니다]

5/26 보아치과 1회차 워크숍용 Studio 빌드가 나왔습니다.
오늘~수요일(5/22) 안에 6분 모두 설치 + 첫 메시지 응답까지 확인 부탁드려요.

▶ 설치 (Mac만 지원, 5분)
Terminal에서 한 줄:
curl -fsSL https://raw.githubusercontent.com/jayleekr/hypeproof-studio-releases/main/install-mac.sh | bash

자동으로 v0.1.0을 받아 ~/Applications/HypeProof Studio.app 에 깔립니다.
(macOS Gatekeeper 우회는 스크립트가 처리)

▶ 처음 실행
1. HypeProof Studio.app 실행
2. 좌측 채팅 패널에서 Workshop token 입력창이 뜸
   → 제가 개별 DM으로 보내드린 토큰 붙여넣기
3. 채팅창에 "안녕" 한 줄 보내고 응답 오면 OK

▶ 확인 후 단톡방에 회신
"✅ [이름] 설치 + 첫 응답 OK" 한 줄로 부탁드립니다.

▶ 안 되면
- 스크린샷 + 실행 시각을 단톡방에 올려주세요. 제가 바로 봅니다.
- 토큰 분실 → DM 주세요. 즉시 재발급.

▶ D-1 리허설
5/25(월) 저녁, 30분. 시간은 내일 다시 고정해서 공지드릴게요.

— Jay
```

---

## Operator 응대 가이드 (내부용, 카톡엔 보내지 말 것)

### 자주 나올 질문 / 즉답 템플릿

**Q. "권한 없음 / damaged / can't be opened" 떠요**
→ Gatekeeper. 스크립트가 처리해야 정상인데 누락된 경우:
```bash
xattr -dr com.apple.quarantine ~/Applications/HypeProof\ Studio.app
```

**Q. 토큰 어디 입력해요?**
→ 앱 실행 후 왼쪽 사이드바 채팅 아이콘 → 입력창에 토큰. 한 번 입력하면 다음 실행부터는 자동 (VS Code SecretStorage).

**Q. 응답이 안 와요**
→ `~/Library/Application Support/HypeProof-Studio/logs/` 압축해서 DM 부탁.
→ 99% 사유: 토큰 만료(2026-06-30까지 유효) / 네트워크 / api.hypeproof-ai.xyz 막힘.

**Q. Windows 가능해요?**
→ Phase 6에서 GitHub Actions로 빌드 예정. 이번 1회차는 Mac만.

### 내부 체크리스트 (Jay)

- [ ] 6명에게 워크숍 토큰 개별 DM 발송 (issue-token.ts로 발급)
- [ ] 단톡방에 위 카톡 본문 발송
- [ ] 24h 내 6명 ✅ 회신 확인
- [ ] 5/22(금) 18:00 시점 미설치자 1:1 follow-up
- [ ] 5/25(월) D-1 리허설 시간 단톡방에 고정

### 토큰 발급 (참고)

```bash
cd worker
# 6명 각자: u=오퍼레이터 식별자, c=cohort, exp=만료
node scripts/issue-token.mjs \
  --u operator-01 \
  --c boah-dental-teaser-2026-s1 \
  --exp 2026-06-30T23:59:59+09:00
# (스크립트가 HPS_SIGNING_SECRET을 .dev.vars / ~/.env에서 로드)
```
