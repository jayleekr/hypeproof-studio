# 2회차 (Load week) Profile — 검토용 DRAFT

> ⚠ 아직 worker에 등록 안 됨. Jay 검토 후 활성. 1회차 dogfood 데이터 + 자녀 입장 검토 거친 후 확정.

## 컨셉 (HYROX 제안서 §03 매핑)

> Week 2 — Load — **"만족하지 않는다"** — 부하걸기·만족유의·역할몰입·역목표 — "됐다가 아니라 더 해봐"

자녀 화면에선:
- 1회차에서 만든 게임을 가져옴 (자녀가 자기 게임 기억함)
- "이번에는 한 단계 어렵게 만들어볼까?"
- 코치도 약간 더 도전적 톤 (같은 친구지만 자녀가 컸으니 기대도 올라감)
- **"다시" 버튼 카운터 노출** — "이번이 5번째 다른 방식!" 식으로

## 1회차 vs 2회차 변경점 (`ux.*` diff)

```diff
ux: {
  coach: {
    naming_mode: "user_names_it",
    fallback_name: "코치",
-   naming_prompt_md: "같이 게임 만들 친구의 **이름**을 지어주세요 🎮",
-   personality_prompt_md: "이 친구는 어떤 친구예요?",
-   revisit_on_entry: false,
+   naming_prompt_md: "오늘은 친구한테 새 성격을 줘볼래요? 이름은 그대로 둬도 좋아요",
+   personality_prompt_md: "이번엔 어떤 친구로 부를래요? *(예: 좀 더 까칠한 친구, 더 똑똑한 친구)*",
+   revisit_on_entry: true,        // ← essence 5 역할 몰입 명시
  },
  suggestions: {
    initial: [
+     { text: "지난 시간에 만든 게임을 더 어렵게 만들어줘", style: "good" },
+     { text: "지난 게임에 약점이 있는지 찾아줘", style: "good" },
+     { text: "이번엔 절대 깨지 못하는 게임을 만들어줘", style: "good" },  // essence 11 역목표 seed
+     { text: "방금 좀 부족했지", style: "weak", caption: "어떤 부분이? 한 가지만 콕 집어줘" },
    ],
    follow_up: [
+     { text: "이거 한 번 더 다른 방식으로", style: "good" },
+     { text: "더 빠르게 + 더 어렵게", style: "good" },
+     { text: "이게 진짜 최선이야? 한 군데만 더 손봐줘", style: "good" },
+     { text: "약한 부분 찾아서 강화해줘", style: "good" },
    ],
  },
  hints: {
    short_input: {
-     enabled: true,
-     min_chars: 5,
-     message_md: "💭 조금 더 자세히 알려줄래요?",
+     enabled: false,                // 2회차엔 자녀가 이미 자세히 쓸 줄 앎. Load는 다른 essence.
+     min_chars: 0,
+     message_md: "",
    },
    roll_input_button: {
      enabled: true,
      label: "✨ 한 번 더 떠올려보기",
      probe_md: "...",
    },
  },
  retry_button: {
    enabled: true,
+   show_counter: true,              // ← essence 4 만족 유예 명시화
+   counter_toast_md: "🔥 이번이 **{n}번째** 다른 방식! 좋아요, 멈추지 마세요.",
  },
}
```

## System prompt 변경점

`worker/src/prompts/sk-biopharm-kids-s2.md` (작성 시):
- 동일 페르소나 (자녀 코치 이름/성격 유지)
- **추가 톤**:
  - "와! 멋져요" → "와 멋진데, 그런데 만약 ___이면 어떻게 될까?"
  - 첫 응답 후 자동으로 "한 번 더 다른 방식으로도 가능해. 같이 해볼까?" 권유
  - 자녀가 "됐어"라고 하면 "정말? 한 군데만 더 손봐볼까?" 한 번만 push
- 안전 룰은 동일

## Profile schema 핵심 필드

```ts
{
  id: "sk-biopharm-kids-2026-grade-3-4-s2",
  display_name: "SK바이오팜 가족 워크숍 (3-4학년) — 2회차 (Load)",
  // ... audience 동일 ...
  essences_focus: [4, 5, 11],       // 1회차 [1, 2, 5, 7, 16]에서 진화
  session: {
    cohort_id: "sk-biopharm-2026-a",
    series_total: 4,
    series_index: 2,                // ← 차이
    hours: 8,
  },
  sandbox: {
    file_write: true,
    workspace_root: "~/HypeProofGames",
    execute_shell: false,
    mcp_tools_enabled: [],           // 여전히 chat-only (3회차에서 도구 enable)
  },
  publishing: {
    enabled: true,
    strategy: "per_user_github_pages",
  },
  // ... ux 위 diff 참조 ...
}
```

## 운영 측면 변경

- Roster: 동일 (1회차와 같은 자녀들이 다시 옴)
- Active session: 강사가 2회차 시작 시 `profile_id = "sk-biopharm-kids-2026-grade-3-4-s2"`로 새 session 시작
- Token: 1회차 토큰은 cohort 같으나 profile 다름 → 403. **신규 발급 필요** (또는 token에서 profile 안 박고 더 유연하게 — 현재는 박혀있음. 디자인 결정 필요)

### Token 유연성 결정 포인트

현재 token에 `p` (profile) 포함 → 회차 바뀌면 토큰 새로 발급해야 함.

대안:
- Token에서 `p` 제거. 대신 active_session의 profile_id로 결정.
- 자녀가 1회차 토큰 그대로 갖고 2회차 와도 동작.

**추천**: 대안 채택. 회차 사이 운영 부담 줄음. 단점: profile-specific 토큰 폐기 능력 잃음 (소수 사례).

→ 2회차 작성 시 함께 검토.

## 작업량 추정

- system prompt MD 작성/튜닝: 1-2시간
- profile.ts 작성 + REGISTRY 등록: 30분
- Token 모델 수정 (decision): 1-2시간 (worker tokens.ts + tests)
- e2e 회차 전환 시나리오 1개: 1시간

총 ~5시간. 1회차 dogfood 끝나고 정해서 진행 권장.

## 검토 시 점검 포인트

1. retry counter — 자녀 8-10세에게 부담 X? 격려 톤 vs 압박 톤 미세 조정
2. "절대 못 깨는 게임" — essence 11 (역목표) 너무 abstract할 수 있음. 1회차 끝나고 자녀가 흥미 보이면 keep, 아니면 단순한 chip으로 교체
3. coach revisit — 1회차 자녀 코치 이름·성격을 매번 다시 짓게 하면 피곤할 수도. 옵션을 "그대로 둘래요?" 먼저 묻고 yes면 skip
4. 1→2 토큰 처리 — 위 디자인 결정 필요
