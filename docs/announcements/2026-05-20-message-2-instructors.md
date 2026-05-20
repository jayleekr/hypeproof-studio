# Message ② — 강사 단톡방 공지 (보아치과 티저 세션)

**보낼 곳**: 강사·보조강사 6명 단톡방
**보내는 시점**: 즉시 (D-6, 2026-05-20)
**행사**: 2026-05-26(화) 보아치과 1회차 **HypeProof 티저 세션**

---

## 카톡 본문 (그대로 복붙)

```
[HypeProof Studio v0.1.0 배포 — 강사·보조강사 6분 설치 부탁드립니다]

5/26(화) 보아치과 1회차 티저 세션용 Studio 빌드가 나왔습니다.
오늘~목요일(5/22) 18시 안에 6분 모두 설치 + 첫 메시지 응답까지 확인 부탁드려요.
(금요일 5/23 저녁 리허설 전까지 모두 설치 완료 필요)

▶ 설치 (Mac만 지원, 5분)
Terminal에서 한 줄:
curl -fsSL https://raw.githubusercontent.com/jayleekr/hypeproof-studio-releases/main/install-mac.sh | bash

자동으로 v0.1.0을 받아 ~/Applications/HypeProof Studio.app 에 깔립니다.
(macOS Gatekeeper 우회는 스크립트가 처리)

▶ 처음 실행
1. HypeProof Studio.app 실행
2. 좌측 채팅 패널에서 토큰 입력창이 뜸 (UI 라벨은 "Workshop token" — 그대로 토큰 붙여넣으면 됨)
   → 제가 개별 DM으로 보내드린 세션 토큰을 붙여넣기
3. 채팅창에 "안녕" 한 줄 보내고 응답 오면 OK

▶ 확인 후 단톡방에 회신
"✅ [이름] 설치 + 첫 응답 OK" 한 줄로 부탁드립니다.

▶ 안 되면
- 스크린샷 + 실행 시각을 단톡방에 올려주세요. 제가 바로 봅니다.
- 토큰 분실 → DM 주세요. 즉시 재발급.

▶ 리허설 (D-3, 5/23 금요일 저녁 30분)
강사·보조강사 6분 + Jay 같이 티저 세션 시나리오 한 번 돌립니다.
정확한 시간은 내일 단톡방에 고정해서 공지드릴게요.
(주말·월요일은 fix buffer로 비워둡니다)

— Jay
```

---

## 강사 응대 가이드 (내부용, 카톡엔 보내지 말 것)

### 자주 나올 질문 / 즉답 템플릿

**Q. "권한 없음 / damaged / can't be opened" 떠요**
→ Gatekeeper. 스크립트가 처리해야 정상인데 누락된 경우:
```bash
xattr -dr com.apple.quarantine ~/Applications/HypeProof\ Studio.app
```

**Q. 토큰 어디 입력해요?**
→ 앱 실행 후 왼쪽 사이드바 채팅 아이콘 → 입력창에 토큰. 한 번 입력하면 다음 실행부터는 자동
(VS Code SecretStorage). UI 라벨이 "Workshop token"으로 보여도 같은 입력창 — 세션 토큰 그대로 붙여넣기.

**Q. 응답이 안 와요**
→ `~/Library/Application Support/HypeProof-Studio/logs/` 압축해서 DM 부탁.
→ 99% 사유: 토큰 만료(2026-06-30까지 유효) / 네트워크 / api.hypeproof-ai.xyz 막힘.

**Q. Windows 가능해요?**
→ Phase 6에서 GitHub Actions로 빌드 예정. 이번 티저는 Mac만.

### 내부 체크리스트 (Jay)

- [ ] 강사·보조강사 6명에게 세션 토큰 개별 DM 발송 (issue-token.ts로 발급)
- [ ] 단톡방에 위 카톡 본문 발송
- [ ] 24h 내 6명 ✅ 회신 확인
- [ ] 5/22(목) 18:00 시점 미설치자 1:1 follow-up (리허설 전 last call)
- [ ] 5/21(수) 중에 5/23(금) D-3 리허설 시간 단톡방에 고정
- [ ] 5/23(금) 리허설 후 fix 항목 정리 → 토·일·월 buffer에서 처리

### 세션 토큰 발급 (참고)

```bash
cd worker
# 강사·보조강사 6명 각자: u=핸들, c=cohort, exp=만료
node scripts/issue-token.mjs \
  --u instructor-01 \
  --c boah-dental-teaser-2026-s1 \
  --exp 2026-06-30T23:59:59+09:00
# (스크립트가 HPS_SIGNING_SECRET을 .dev.vars / ~/.env에서 로드)
```

### 용어 메모 (혼동 방지)

- 본 행사 = **보아치과 1회차 HypeProof 티저 세션** (≠ 워크숍).
  "워크숍"이라는 단어는 별도 라인업인 *SK바이오팜 가족 워크숍 (3-4학년, 8h)* 에만 사용.
- 6명 = **강사·보조강사** (≠ operator, ≠ 운영자). 본인들이 직접 강의 진행.
- "Workshop token" 은 Studio.app UI에 그대로 박혀있는 레거시 라벨 (코드 변경 + 재빌드 필요해서
  D-day 전엔 안 건드림). 한국어 카피에선 "세션 토큰"으로 통일.
