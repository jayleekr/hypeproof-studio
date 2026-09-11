// #897 V4 (#901) — 유료 게이트웨이의 **오디오 거절**을 이름 붙은 계약으로 고정한다.
//
// 왜 음성 코드가 하나도 없는 지금 쓰나:
//   셰한 앱의 webview iframe allow 목록에 microphone 이 0건이고
//   "microphone" 이라는 문자열은 0번 나온다. 즉 **음성 세션은 아직 존재할 수 없다.**
//   그런데 Service 는 이미 오디오를 거절한다(budget-admission validateWire,
//   usage-costs normalizeCostUsage). 그 거절에 이름이 없어서, 나중에 음성을 붙이는
//   변경이 조용히 지워도 아무 테스트도 울지 않는다. V4(비용·예산)가 올라오기 전에
//   **음성 이전의 음성 불가**를 음성 코드 없이 못박아 두는 것이 이 파일의 전부다.
//
// 계측기 자체를 의심하라는 규율(.claude/rules/verification.md 규칙 2)에 따라,
// 모든 거절 단언에는 **같은 경로의 통과 대조군**이 붙어 있다. 대조군이 없으면
// "전부 거절하는 검증기" 나 "아무것도 가격 매기지 않는 엔진" 도 이 파일을 통과한다.
//
// 이 파일이 주장하지 않는 것:
//   - 음성이 동작한다 / 음성 가격이 있다 (둘 다 없다)
//   - 모든 경로가 오디오를 **거절**한다 — /v1/chat/completions 는 거절이 아니라
//     번역 단계에서 조용히 **떨어뜨린다**. 아래에서 실제로 재서 구분해 둔다.
//   - 게이트웨이가 오디오를 **보편적으로** 거절한다. 처음 그렇게 적었는데 **거짓이다.**
//     거절은 `routes/messages.ts:523` 의 `if(executionAccess)` 안에 있다. 즉
//     **계량되는 좌석에서만** 돈다. 계량되지 않는 좌석(`resolveExecutionAccess` 가
//     null — 토큰에 account 없음 · 자금원 헤더 없음 · 코호트 정책 required 아님)에서는
//     `audio` 키가 상류로 **그대로 나간다**. 짐작이 아니라 §2b 에서 재서 박아둔다.
import './harness/loader.mjs';
import assert from 'node:assert/strict';
import { budgetHarness } from './harness/budgets.mjs';
import { syntheticEvent } from './harness/access.mjs';
import { syntheticPrice, syntheticAttempt, syntheticEvidence, openaiRaw, nativeRaw } from './harness/usage-costs.mjs';
const { reserveBudgetAttempt: reserve, resolveExecutionAccess } = await import('../src/lib/budget-admission.ts');
const { normalizeCostUsage, computeUsageCost, publishUsagePrice } = await import('../src/lib/usage-costs.ts');
const { issue } = await import('../src/lib/tokens.ts');
const { withMockUpstream, TEST_SECRET } = await import('./harness/index.mjs');

const attemptRows = h => h.db.prepare('SELECT COUNT(*) n FROM usage_attempt_costs').get().n;
const refusal = (code, status = 403) => err =>
  err.code === code && err.status === status || assert.fail(`expected ${code}/${status}, got ${err.code}/${err.status}`);

// ═══ 1. 입찰(admission) 계약 — 실제 export 된 reserveBudgetAttempt 로 구동한다 ═══
// 소스를 정규식으로 긁지 않는다. validateWire 는 비공개 함수이므로, 그것을 **부르는
// 공개 진입점**을 통해 잰다. 그래야 "함수는 남아 있는데 호출이 빠진" 변경도 잡힌다.
{
  const h = await budgetHarness(undefined, { amount: 1000000 });
  try {
    const access = await h.access();

    // 거절을 먼저 돌린다: 이 시점에 테이블이 비어 있으므로 "거절은 아무것도
    // 기록하지 않는다" 를 행 수로 직접 확인할 수 있다.
    const refused = [
      // body.audio — OpenAI 의 음성 출력 요청 필드.
      ['body.audio', { audio: { voice: 'alloy', format: 'pcm16' } }, 'unbounded_execution_feature'],
      // modalities 에 text 가 아닌 항목이 섞이면 거절. 'audio' 만 있는 경우와
      // text 와 함께 온 경우를 따로 잰다 — some() 이 아니라 includes() 로 바뀌는
      // 식의 변경을 한쪽만으로는 잡을 수 없다.
      ['modalities:[text,audio]', { modalities: ['text', 'audio'] }, 'unbounded_execution_feature'],
      ['modalities:[audio]', { modalities: ['audio'] }, 'unbounded_execution_feature'],
      // messages 안의 input_audio 블록. 최상위 키가 아니라 **중첩**이라 별도 경로다.
      ['input_audio block', {
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }] }],
      }, 'unbounded_media_or_tool'],
      // 깊게 숨겨도 걸린다 — visit() 가 전체를 훑는지 재는 단언. 한 겹만 보는
      // 구현이면 위 단언은 통과하고 이것만 실패한다.
      ['nested input_audio inside tool_result', {
        messages: [{
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'input_audio', input_audio: { data: 'AAAA' } }] }],
        }],
      }, 'unbounded_media_or_tool'],
    ];
    for (const [label, patch, code] of refused) {
      const input = h.input('refused-' + label.replace(/[^a-z0-9]+/gi, '-'));
      await assert.rejects(
        reserve(h.env, access, { ...input, body: { ...input.body, ...patch } }),
        refusal(code), label,
      );
    }
    assert.equal(attemptRows(h), 0, '거절은 내구성 있는 행을 하나도 남기지 않는다');

    // ── POSITIVE CONTROL ─────────────────────────────────────────────────────
    // 같은 access, 같은 harness, 같은 모양의 평범한 텍스트 요청은 통과한다.
    // 이것이 없으면 `throw new AccessError(...)` 한 줄짜리 validateWire 도 위의
    // 모든 단언을 만족시킨다.
    const plain = h.input('text-only-control');
    const before = structuredClone(plain.body.messages);
    const attempt = await reserve(h.env, access, plain);
    assert.equal(typeof attempt.request_id, 'string');
    assert.equal(attempt.request_id, 'text-only-control');
    assert.equal(attemptRows(h), 1, '통과한 요청은 행을 남긴다 — 앞의 0 이 의미를 갖는 근거');
    assert.deepEqual(plain.body.messages, before, '통과 경로는 messages 를 건드리지 않는다');

    // 경계를 정확히 잰다: modalities:['text'] 는 거절이 아니다. `modalities` 키의
    // 존재만으로 막는 구현(과하게 엄격한 계측기/제품)을 잡는 대조군.
    const textModality = h.input('modalities-text-only');
    textModality.body.modalities = ['text'];
    const ok = await reserve(h.env, access, textModality);
    assert.equal(ok.request_id, 'modalities-text-only');
    assert.equal(attemptRows(h), 2);

    // ── 프로토콜 축 ──────────────────────────────────────────────────────────
    // 위 단언은 전부 `h.input()` 의 기본 프로토콜(`anthropic-messages`) 로만 돌았다.
    // 그래서 미디어 블록 검사를 그 프로토콜 하나로 좁히는 변경
    // (`protocol==='anthropic-messages' && [...].includes(value.type)`) 이 전부 초록으로
    // 지나갔다 — 그런데 `routes/chat.ts` 는 `openai-chat` 으로 같은 함수를 부른다.
    // 즉 한 축만 재고 "게이트웨이가 막는다" 고 쓰면 다른 축이 조용히 열린다.
    for (const protocol of ['anthropic-messages', 'openai-chat']) {
      const nested = h.input(`protocol-axis-${protocol}`);
      await assert.rejects(
        reserve(h.env, access, {
          ...nested, protocol,
          body: { ...nested.body, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAAA' } }] }] },
        }),
        refusal('unbounded_media_or_tool'), `${protocol}: 미디어 블록 거절이 이 프로토콜에서 사라졌다`,
      );
      // 대조군 — 위 403 이 **오디오 때문**이고 프로토콜 때문이 아니라는 증거.
      // `openai-chat` 축은 이 harness 에 단가 바인딩이 없어서 평범한 텍스트도
      // 통과하지 못한다(`budget_price_not_configured`). 그래서 "200 이 된다" 대신
      // **거절 사유가 다르다**를 단언한다. validateWire 는 단가 조회보다 먼저 돌기
      // 때문에 이 구분이 실제로 성립한다 — 측정해서 확인했다.
      const plainAxis = h.input(`protocol-axis-ok-${protocol}`);
      let code = 'passed';
      try {
        await reserve(h.env, access, { ...plainAxis, protocol });
      } catch (err) {
        code = err.code;
      }
      assert.notEqual(
        code, 'unbounded_media_or_tool',
        `${protocol}: 평범한 텍스트도 미디어 사유로 거절된다 — 위 403 은 오디오 판정이 아니다`,
      );
      // 그리고 그 사유가 무엇이었는지 적어둔다. 여기가 'passed' 로 바뀌면 단가 바인딩이
      // 생긴 것이고, 그때는 위 대조군을 200 단언으로 **승급**하라.
      assert.ok(
        code === 'passed' || code === 'budget_price_not_configured',
        `${protocol}: 예상치 못한 사유 ${code} — 이 축의 대조군 의미를 다시 확인하라`,
      );
    }

    console.log('PASS admission: body.audio · modalities · 중첩 input_audio 거절, 텍스트/modalities:[text] 통과 대조군, 두 프로토콜 축');
  } finally { h.close(); }
}

// ═══ 2. 거절이 **도달 가능한가** — 실제 HTTP 경로에서 잰다 ════════════════════
// 위 단언들은 "validateWire 가 거절한다" 까지만 증명한다. 요청 경로에 꽂혀 있지
// 않으면 전부 죽은 코드다. 그래서 인증된 /v1/messages 를 실제로 때린다.
//
// 이 경로에서 도달 가능한 이유는 짐작이 아니라 코드에서 확인했다:
// routes/messages.ts 의 upstreamBody 는 `{...raw, ...}` 스프레드-퍼스트라 클라이언트가
// 보낸 `audio`/`modalities` 키가 살아남고, messages 의 content 블록도
// normalizeSystemRoleMessages → scrubToolResultSecrets 를 통과해 그대로 남는다.
{
  const profile = 'canary-sdk-contract', cohort = 'canary-internal';
  const h = await budgetHarness(undefined, { amount: 1000000, cohort });
  try {
    const price = syntheticPrice('audio-route-price', 'anthropic-messages');
    price.bounds['tokens:output'] = 20000;
    await publishUsagePrice(h.env, price);
    h.db.prepare('DELETE FROM budget_runtime_prices WHERE root_id=?').run(h.root.account_id);
    h.db.prepare('INSERT INTO budget_runtime_prices VALUES (?,?,?,?,?)')
      .run(h.root.account_id, price.provider, price.model, 'anthropic-messages', price.revision);
    await h.request(`/admin/access/cohorts/${cohort}/policy`, { method: 'PUT', body: { expected_revision: 0, required: true, allow_personal: false } });
    h.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(cohort, 'Synthetic audio-refusal class');
    const session = { session_id: 'audio-session', profile_id: profile, starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString() };
    h.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)').run(session.session_id, cohort, profile, session.starts_at, session.ends_at);
    await h.env.HPS_KV.put(`cohort:${cohort}:active_session`, JSON.stringify(session));
    h.env.ANTHROPIC_API_KEY = 'synthetic-key';
    const auth = 'Bearer ' + (await issue({ u: 'kid01', c: cohort, p: profile }, 1, TEST_SECRET)).token;
    const funding = { 'x-hps-funding-source': h.contract.contract_id };
    const base = { model: price.model, max_tokens: 10, stream: false, messages: [{ role: 'user', content: 'synthetic text turn' }] };

    await withMockUpstream(
      () => Response.json({ model: price.model, content: [{ type: 'text', text: 'Synthetic' }], usage: nativeRaw }),
      async calls => {
        // POSITIVE CONTROL FIRST — 이 좌석/이 토큰/이 본문은 실제로 200 이고 상류를
        // 한 번 부른다. 이것이 없으면 아래 403 들은 "이 경로가 원래 죽어 있다" 와
        // 구별되지 않는다.
        const okay = await h.request('/v1/messages', { auth, method: 'POST', body: base, headers: funding });
        assert.equal(okay.status, 200, okay.text);
        assert.equal(calls.length, 1, '대조군은 상류에 도달한다');

        const cases = [
          ['audio', { ...base, audio: { voice: 'alloy', format: 'pcm16' } }, 'unbounded_execution_feature'],
          ['modalities', { ...base, modalities: ['text', 'audio'] }, 'unbounded_execution_feature'],
          ['input_audio block', {
            ...base,
            messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }] }],
          }, 'unbounded_media_or_tool'],
        ];
        for (const [label, body, code] of cases) {
          const calledBefore = calls.length;
          const r = await h.request('/v1/messages', { auth, method: 'POST', body, headers: funding });
          assert.equal(r.status, 403, `${label}: ${r.text}`);
          assert.equal(r.json?.error?.code, code, `${label}: ${r.text}`);
          assert.equal(calls.length, calledBefore, `${label}: 거절은 유료 상류를 부르지 않는다`);
        }
      },
    );
    console.log('PASS reachable: /v1/messages 가 오디오 본문을 403 으로 거절하고 상류를 부르지 않는다 (200 대조군 동반)');
  } finally { h.close(); }
}

// ═══ 2b. 거절의 **범위** — 계량되지 않는 좌석에는 오디오 가드가 없다 ═══════════
// §2 는 `required:true` 정책 + 자금원 헤더로, 즉 **계량되는 좌석**에서 403 을 재었다.
// 그것만 두면 "게이트웨이가 오디오를 막는다" 로 읽힌다. 실제 가드는
// `routes/messages.ts:523` 의 `if(executionAccess)` 안에 있으므로 그 밖에서는 없다.
//
// 2026-09-10 측정값(이 단언의 출처): 정책 미설정 + 자금원 헤더 없음으로 동일 좌석을
// 때리면 text 200 / audio 200 / input_audio 200 이고, 상류로 나간 본문에
// `"audio":{"voice":"alloy","format":"pcm16"}` 가 그대로 들어 있다.
//
// 이 단언이 바라는 것은 통과가 아니라 **기록**이다. V4 에서 음성을 붙일 때 가드를
// admission 밖(게이트 공통 경로)으로 옮기면 이 단언이 터진다 — 그때 터지는 것이
// 정답이고, 머리말을 고치고 §2 를 확장하면 된다. 지금 이걸 안 적어두면 "이미 막고
// 있다" 는 잘못된 안심이 인수 기록에 남는다.
{
  const profile = 'canary-sdk-contract', cohort = 'canary-internal';
  const h = await budgetHarness(undefined, { amount: 1000000, cohort });
  try {
    const price = syntheticPrice('audio-unmetered-price', 'anthropic-messages');
    await publishUsagePrice(h.env, price);
    h.db.prepare('INSERT INTO cohorts(id,display_name) VALUES (?,?)').run(cohort, 'Unmetered audio-scope class');
    const session = { session_id: 'audio-unmetered', profile_id: profile, starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString() };
    h.db.prepare('INSERT INTO sessions(id,cohort_id,profile_id,starts_at,ends_at) VALUES (?,?,?,?,?)').run(session.session_id, cohort, profile, session.starts_at, session.ends_at);
    await h.env.HPS_KV.put(`cohort:${cohort}:active_session`, JSON.stringify(session));
    h.env.ANTHROPIC_API_KEY = 'synthetic-key';
    const auth = 'Bearer ' + (await issue({ u: 'kid01', c: cohort, p: profile }, 1, TEST_SECRET)).token;
    const base = { model: price.model, max_tokens: 10, stream: false, messages: [{ role: 'user', content: 'synthetic text turn' }] };

    await withMockUpstream(
      () => Response.json({ model: price.model, content: [{ type: 'text', text: 'Synthetic' }], usage: nativeRaw }),
      async calls => {
        // 대조군 — 이 좌석이 **정말 계량되지 않는다**. executionAccess 가 null 이라는
        // 것을 간접(200)이 아니라 직접 확인한다. 이게 없으면 아래 200 들이 "계량되는데
        // 그냥 통과했다" 와 구별되지 않는다.
        const unmeteredAccess = await resolveExecutionAccess(h.env, { u: 'kid01', c: cohort, p: profile }, undefined);
        assert.equal(unmeteredAccess, null, '이 좌석이 계량된다면 §2b 의 전제가 틀렸다');
        // 그리고 같은 헬퍼가 자금원을 주면 계량을 **찾아낸다** — 헬퍼가 항상 null 이
        // 아님을 증명하는 양성 대조군.
        assert.notEqual(
          await resolveExecutionAccess(h.env, { u: 'kid01', c: cohort, p: profile }, h.contract.contract_id),
          null,
          'resolveExecutionAccess 가 항상 null 이다 — 계측기가 고장났다',
        );

        const before = calls.length;
        const ok = await h.request('/v1/messages', { auth, method: 'POST', body: base });
        assert.equal(ok.status, 200, ok.text);

        // 오디오 본문이 **거절되지 않고** 상류까지 간다. 오늘의 사실이다.
        const audio = await h.request('/v1/messages', { auth, method: 'POST', body: { ...base, audio: { voice: 'alloy', format: 'pcm16' } } });
        assert.equal(audio.status, 200, `계량 없는 좌석에서 오디오가 403 이 됐다 — 가드가 옮겨졌다면 머리말과 §2 를 고쳐라: ${audio.text}`);
        assert.equal(calls.length, before + 2, '두 요청 모두 상류에 도달했다');
        const forwarded = JSON.parse(calls[calls.length - 1].init.body);
        assert.deepEqual(
          forwarded.audio,
          { voice: 'alloy', format: 'pcm16' },
          'audio 키가 상류로 그대로 나간다 — 이 경로에 가드가 없다는 증거',
        );

        const nested = await h.request('/v1/messages', {
          auth, method: 'POST',
          body: { ...base, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }] }] },
        });
        assert.equal(nested.status, 200, `중첩 input_audio 도 계량 없는 좌석에서는 통과한다: ${nested.text}`);
      },
    );
    console.log('PASS scope: 오디오 거절은 **계량되는 좌석 전용**이다 — 계량 없는 좌석은 audio 를 상류로 그대로 흘린다');
  } finally { h.close(); }
}

// ═══ 3. /v1/chat/completions 는 거절이 아니라 **탈락**이다 — 관측된 비대칭 ═════
// 짐작하지 않고 쟀다: lib/translate.ts 의 translateOpenAI 는 화이트리스트로 새
// 본문을 조립하므로 클라이언트의 `audio`/`modalities` 는 validateWire 에 **도달조차
// 하지 않는다**. input_audio 블록도 sanitizeContentBlocks 가 미지의 타입으로 떨군다.
// 결과적으로 오디오가 제공자에 닿지는 않지만, 그 방어는 **관측 가능한 거절이 아니다**.
// V4 가 "게이트웨이가 오디오를 403 한다" 를 전 경로의 성질로 쓰면 틀린다. 아래는 그
// 사실을 고정하는 NEGATIVE CONTROL 이다 — 언젠가 이 경로가 403 으로 바뀌면 이 단언이
// 실패하고, 그때 요구사항 행을 같이 옮기면 된다.
{
  const { translateOpenAI } = await import('../src/lib/translate.ts');
  const { getProfile } = await import('../src/profiles/index.ts');
  const profile = getProfile('studio-model-practice');
  // **바이트로 잰다, 키 이름으로 재지 않는다.** 처음 이 절은 `input_audio` 라는
  // 키 이름의 부재만 확인했다. 그래서 `sanitizeContentBlocks` 가 블록을
  // `{ type: 'audio', source: b.input_audio }` 로 **바꿔서 실어 보내는** 변경이 전부
  // 초록으로 지나갔다 — 키 이름은 사라졌고 base64 는 제공자까지 갔다. 그게 정확히
  // 이 절이 막으려던 일이다. 그래서 눈에 띄는 센티널을 심고 **그 바이트**를 찾는다.
  const AUDIO_SENTINEL = 'QVVESU9TRU5USU5FTF9ET19OT1RfRk9SV0FSRA';
  const wire = translateOpenAI({
    // 별칭이 아니라 실제 openai 모델 키를 준다 — 별칭은 이 프로필에서 anthropic 으로
    // 풀려서 translateOpenAI('openai') 가 모델 단계에서 먼저 던진다(관측 후 수정).
    model: 'gpt-5.6-luna', max_tokens: 10,
    modalities: ['text', 'audio'],
    audio: { voice: 'alloy', format: 'pcm16' },
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: AUDIO_SENTINEL, format: 'wav' } }, { type: 'text', text: '안녕' }] }],
  }, profile, {}, 'openai');
  assert.ok(!('audio' in wire), 'TODAY: translateOpenAI 가 audio 를 떨군다 — 403 이 아니다');
  assert.ok(!('modalities' in wire), 'TODAY: translateOpenAI 가 modalities 를 떨군다 — 403 이 아니다');
  const serialized = JSON.stringify(wire);
  assert.equal(serialized.includes('input_audio'), false, 'TODAY: input_audio 블록이 조용히 사라진다');
  assert.equal(
    serialized.includes(AUDIO_SENTINEL), false,
    '오디오 바이트가 상류 본문에 남아 있다 — 키 이름만 바뀌고 내용이 그대로 간다',
  );
  assert.equal(serialized.includes('pcm16'), false, '오디오 포맷 힌트가 상류 본문에 남아 있다');
  // 센티널 탐침의 양성 대조군 — 이 문자열은 **입력에는 분명히 있었다**. 그게 아니면
  // 위 단언은 "아무 문자열이나 없다" 와 구별되지 않는다.
  assert.ok(
    JSON.stringify({ input_audio: { data: AUDIO_SENTINEL } }).includes(AUDIO_SENTINEL),
    '센티널 탐침이 고장났다',
  );
  // 대조군: 같은 호출에서 텍스트는 살아남는다. 이게 없으면 "translateOpenAI 가
  // 전부 버린다" 는 고장도 위 세 단언을 통과한다.
  assert.ok(JSON.stringify(wire.messages).includes('안녕'), '같은 턴의 텍스트는 상류로 간다');
  console.log('PASS asymmetry pinned: chat 경로는 오디오를 떨구고, messages 경로는 403 한다');
}

// ═══ 4. 비용 엔진 — 오디오 토큰을 텍스트 단가로 매기지 않는다 ═════════════════
{
  const price = syntheticPrice('audio-cost-price', 'openai-chat');
  const attempt = syntheticAttempt(syntheticEvent('audio-cost', 'cohort', 'synthetic-cohort'), price, 'audio-cost-1', 'audio-cost-job');
  const priceOf = normalized => computeUsageCost(attempt, syntheticEvidence(attempt, normalized), price);

  // ── POSITIVE CONTROL: 오디오가 없으면 온전히 가격이 매겨진다 ───────────────
  const plain = normalizeCostUsage('openai-chat', openaiRaw);
  assert.deepEqual(plain.issues, [], 'plain usage 는 issue 가 없다');
  assert.equal(plain.meters['tokens:input'], 10);
  assert.equal(plain.meters['tokens:output'], 2);
  assert.equal(plain.meters['tokens:cache_read'], 20);
  assert.equal(plain.meters['tokens:cache_write'], 10);
  const plainCost = priceOf(plain);
  assert.equal(plainCost.state, 'priced');
  assert.equal(plainCost.amount_micro, 38, '텍스트 단가 합 — 아래 값들이 "다르다" 고 말할 기준');

  // ── 입력 쪽 오디오 토큰 ───────────────────────────────────────────────────
  const inAudio = normalizeCostUsage('openai-chat', {
    ...openaiRaw, prompt_tokens_details: { ...openaiRaw.prompt_tokens_details, audio_tokens: 7 },
  });
  assert.ok(inAudio.issues.includes('non_text_tokens'), 'issue 이름이 계약이다 — 문구가 바뀌면 하류 판정이 조용히 죽는다');
  for (const m of ['tokens:input', 'tokens:cache_read', 'tokens:cache_write'])
    assert.equal(inAudio.meters[m], null, `${m} 는 텍스트로 집계되지 않는다`);
  assert.equal(inAudio.meters['tokens:output'], 2, '출력 쪽은 오염되지 않는다 — 전부 null 로 만드는 구현과 구별');
  const inCost = priceOf(inAudio);
  assert.notEqual(inCost.amount_micro, 38, '오디오가 섞인 입력을 텍스트 단가로 매기지 않는다');
  assert.equal(inCost.state, 'partial');
  assert.equal(inCost.amount_micro, 6, '가격이 붙는 것은 남은 출력 토큰뿐');
  for (const m of ['tokens:input', 'tokens:cache_read', 'tokens:cache_write'])
    assert.ok(inCost.issues.includes('missing:' + m), `${m} 가 누락으로 기록된다`);
  assert.ok(inCost.issues.includes('non_text_tokens'), '원인이 비용 문서까지 전달된다');

  // ── 출력 쪽 오디오 토큰 ───────────────────────────────────────────────────
  const outAudio = normalizeCostUsage('openai-chat', {
    ...openaiRaw, completion_tokens_details: { ...openaiRaw.completion_tokens_details, audio_tokens: 3 },
  });
  assert.ok(outAudio.issues.includes('non_text_tokens'));
  assert.equal(outAudio.meters['tokens:output'], null);
  assert.equal(outAudio.meters['tokens:input'], 10, '입력 쪽은 오염되지 않는다');
  assert.notEqual(priceOf(outAudio).amount_micro, 38);

  // ── 양쪽 다 오디오면 가격이 전혀 매겨지지 않는다 ──────────────────────────
  const bothAudio = normalizeCostUsage('openai-chat', {
    ...openaiRaw,
    prompt_tokens_details: { ...openaiRaw.prompt_tokens_details, audio_tokens: 7 },
    completion_tokens_details: { ...openaiRaw.completion_tokens_details, audio_tokens: 3 },
  });
  const bothCost = priceOf(bothAudio);
  assert.equal(bothCost.state, 'unpriced');
  assert.equal(bothCost.amount_micro, null, '음성 턴은 0원으로도, 텍스트 값으로도 기록되지 않는다');

  // ── 경계: audio_tokens:0 은 오디오가 아니다 ───────────────────────────────
  // 제공자가 필드를 항상 채워 보내는 경우를 텍스트 턴으로 유지한다. 이 대조군이
  // 없으면 "audio_tokens 키만 있으면 전부 무가격" 으로 바꿔도 테스트가 통과한다.
  const zeroAudio = normalizeCostUsage('openai-chat', {
    ...openaiRaw,
    prompt_tokens_details: { ...openaiRaw.prompt_tokens_details, audio_tokens: 0 },
    completion_tokens_details: { ...openaiRaw.completion_tokens_details, audio_tokens: 0 },
  });
  assert.ok(!zeroAudio.issues.includes('non_text_tokens'));
  assert.equal(priceOf(zeroAudio).amount_micro, 38);

  // ── NEGATIVE CONTROL: anthropic-messages 쪽에는 같은 방어가 **없다** ──────
  // 오늘의 사실을 그대로 박아둔다. Messages API 사용량에 오디오 차원이 아직
  // 없으므로 이것이 현재 버그라고 주장하지 않는다. 다만 음성이 native 경로로
  // 올라오면 이 단언이 실패해야 하고, 그때 V4 가 가격 차원을 추가해야 한다.
  const nativePrice = syntheticPrice('audio-native-price', 'anthropic-messages');
  const nativeAttempt = syntheticAttempt(syntheticEvent('audio-native', 'cohort', 'synthetic-cohort'), nativePrice, 'audio-native-1', 'audio-native-job');
  const nativeAudio = normalizeCostUsage('anthropic-messages', { ...nativeRaw, audio_tokens: 9, input_audio_tokens: 9 });
  assert.ok(
    !nativeAudio.issues.includes('non_text_tokens'),
    'TODAY: native 경로는 오디오 토큰을 보지 않는다. 여기가 실패하면 방어가 생긴 것이니 요구사항 행을 옮겨라',
  );
  assert.equal(nativeAudio.meters['tokens:input'], 10, 'TODAY: native 경로는 그대로 텍스트로 집계한다');
  const nativeCost = computeUsageCost(nativeAttempt, syntheticEvidence(nativeAttempt, nativeAudio), nativePrice);
  assert.equal(nativeCost.state, 'priced', 'TODAY: native 오디오 필드는 가격 산정을 막지 않는다 — V4 의 공백');

  console.log('PASS cost engine: non_text_tokens 로 텍스트 단가를 거부(openai-chat), native 경로 공백을 음성 대조군으로 고정');
}

console.log('audio-refusal-contract: 음성 코드가 없는 상태의 오디오 거절 계약 — OK');
