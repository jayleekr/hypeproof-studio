# 런북 — 한 코호트에서 트랙 바꾸기 (오전 → 오후)

> 8/22 SK바이오팜: 오전 3-4학년, 오후 5-6학년. 두 트랙은 **프로필이 다릅니다.**
>
> 2026-08-19 `boah-dental-2026-a` 에서 전 과정 리허설 완료. 아래 거동은 전부 실측입니다.

## 왜 이 문서가 필요한가

**한 코호트에 활성 세션은 하나뿐이고, 그 세션은 프로필 하나에 고정됩니다**
(`admin.ts` — *"active_session is a single key per cohort"*). 세션에 고정되지 않은
프로필의 토큰은 막힙니다:

```
{"error":{"message":"이 토큰은 다른 회차용이에요.","type":"session_profile_mismatch"}} 403
```

즉 **점심에 세션을 바꿔주지 않으면 오후 참가자 전원이 로그인하지 못합니다.**

## 먼저: 안심해도 되는 것

리허설로 확인된 사실입니다. 불필요한 걱정을 없애려고 먼저 적습니다.

| 걱정 | 실측 결과 |
|---|---|
| 오후 토큰을 아침에 미리 발급해도 되나? | **된다.** 전환 후 재발급 없이 그대로 통과 |
| 세션을 닫으면 토큰이 죽나? | **안 죽는다.** `jti` 를 넘기지 않으면 `revoked: null` |
| 실수로 남의 세션을 덮어쓰면? | **막힌다.** `force:true` 없이는 **409** |

토큰은 아침에 전부 발급해서 나눠줘도 됩니다. 게이트는 `session.profile_id` 하나로만 뒤집힙니다.

## 절차

`$PW` = admin 비밀번호, `$C` = 코호트 id (`sk-biopharm-2026-a`).

### 1. 오전 시작

```bash
curl -s -u "admin:$PW" -X POST \
  "https://api.hypeproof-ai.xyz/admin/cohorts/$C/session/open" \
  -H 'content-type: application/json' \
  -d '{"profile_id":"sk-biopharm-kids-2026-grade-3-4-s1",
       "user":"강사-오전",
       "token_hours":12,
       "session_hours":4}'
```

### 2. 상태 확인 (수업 중 아무 때나)

```bash
curl -s -u "admin:$PW" \
  "https://api.hypeproof-ai.xyz/admin/cohorts/$C/state" | jq '.session.profile_id, .roster_size'
```

### 3. 점심 — 트랙 전환

**두 줄입니다. 순서가 중요합니다.**

```bash
# (a) 오전 세션 닫기 — jti 를 절대 넘기지 마세요 (아래 함정 1)
curl -s -u "admin:$PW" -X POST \
  "https://api.hypeproof-ai.xyz/admin/cohorts/$C/session/close" \
  -H 'content-type: application/json' -d '{}'

# (b) 오후 세션 열기
curl -s -u "admin:$PW" -X POST \
  "https://api.hypeproof-ai.xyz/admin/cohorts/$C/session/open" \
  -H 'content-type: application/json' \
  -d '{"profile_id":"sk-biopharm-kids-2026-grade-5-6-s1",
       "user":"강사-오후",
       "token_hours":8,
       "session_hours":4}'
```

`close` 없이 `open` 만 하면 **409** 가 납니다(가드가 정상 동작한 것). 그때는
`"force": true` 를 넣거나 `close` 를 먼저 하세요. **`close` 먼저가 안전합니다** —
`force` 는 남의 수업을 조용히 끝낼 수 있는 문입니다.

### 4. 종료

```bash
curl -s -u "admin:$PW" -X POST \
  "https://api.hypeproof-ai.xyz/admin/cohorts/$C/session/close" \
  -H 'content-type: application/json' -d '{}'
```

## 함정 — 전부 실측으로 확인한 것

### 1. `close` 에 `jti` 를 넘기면 그 토큰이 죽는다

`session/close` 는 `jti` 를 주면 **그 토큰을 폐기합니다**(`reason: session-close`).
점심 전환에서는 넘기지 마세요. 빈 본문 `{}` 이면 `revoked: null` 로 아무도 안 죽습니다.

### 2. close 와 open 사이에는 아무도 채팅할 수 없다

세션이 없는 상태라 **모든** 토큰이 막힙니다. 두 명령을 **연달아** 치세요.
수업 중에 창을 띄워놓고 천천히 하지 마세요.

> 이 구간의 정확한 에러 문구는 측정하지 않았습니다 — 코드상 `session_inactive`
> 경로입니다. 점심시간이라 아이가 칠 일이 없어 실측 우선순위에서 뺐습니다.

### 3. `session/open` 은 부수효과가 두 개 있다

`user` 로 넘긴 이름이 **roster 에 자동 추가**되고, 그 사람 앞으로 **토큰이 하나
발급**됩니다. 강사 계정을 쓰면 문제 없지만, 아무 이름이나 넣으면 roster 에
쓰레기가 쌓입니다. 리허설에서 roster 가 115 → 117 로 늘어난 것이 이 경로입니다.

### 4. `token_hours` 와 `session_hours` 는 다른 것이고, 둘 다 최대 24

- `session_hours` — 그 트랙의 수업 창
- `token_hours` — 학생 토큰의 수명. **발급 시각부터** 셉니다

아침 9시에 `token_hours: 6` 으로 오후 토큰을 발급하면 **오후 3시에 죽습니다.**
오전에 전부 발급할 거면 **하루를 덮게 넉넉히**(10~12) 잡으세요.

### 5. `401` 을 만료로 단정하지 말 것

`403 session_inactive` = 세션을 열어야 함. `403 session_profile_mismatch` = 트랙 전환을
안 했음. `401` = 토큰이 **거부됨** — 만료가 흔한 원인이지만 단정하지 마세요
(`.claude/rules/verification.md` 참조: 이 습관이 실제로 이틀을 태웠습니다).

30초 만에 원인을 반으로 가르는 법:

```bash
curl -H "Authorization: Bearer <학생토큰>" https://api.hypeproof-ai.xyz/v1/profile
```

200 이면 토큰은 무죄이고, 클라이언트가 **무엇을 대신 보냈는지**를 봐야 합니다.

## 리허설 기록 (2026-08-19, `boah-dental-2026-a`)

실 워크숍 코호트를 건드리지 않으려고 프로필 2개를 가진 치과 코호트로 밟았습니다.
같은 코드 경로입니다.

```
오전 세션(프로필 A) 중
  오전 토큰(A)                     OK       게이트 통과
  오후 토큰(B, 아침에 미리 발급)    BLOCKED  session_profile_mismatch

전환: close (revoked=None) → open(프로필 B)

오후 세션(프로필 B) 중 — 재발급 없음
  오전 토큰(A)                     BLOCKED  session_profile_mismatch
  오후 토큰(B) ← 아침에 발급한 그것  OK       게이트 통과

force 없이 덮어쓰기                HTTP 409  가드 정상
```

정리 시 세션을 닫고 프로브 토큰 4개를 전부 폐기했습니다. `switchdrill-am`,
`switchdrill-pm` 두 항목이 치과 roster 에 남아 있습니다(토큰은 폐기됨 —
roster 는 개별 삭제 API 가 없어 전체 재작성이 필요해서 두었습니다).

## 관련

`worker/src/lib/chat-gate.ts` (게이트 순서) · `worker/src/routes/admin.ts`
(session open/close) · #373 · `docs/runbook.md`
