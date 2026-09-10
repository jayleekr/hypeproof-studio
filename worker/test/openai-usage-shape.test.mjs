// openai-chat usage 정규화를 **실제 OpenAI 가 보내는 모양**으로 잠근다.
//
// 왜 이 파일이 생기나: 기존 openai-chat 비용 단언은 전부 하네스의 `openaiRaw` 하나를
// 먹였고, 그 fixture 에는 `prompt_tokens_details.cache_write_tokens` 가 들어 있다.
// 그 필드는 **OpenAI 가 보내는 것이 아니다** — 레포 전체에서 fixture 와 그걸 읽는 두
// 줄 말고는 등장하지 않는다. 그래서 계측기가 **가장 틀릴 법한 방향으로 실패할 수
// 없었다**(verification.md 규칙 2: 양성 대조군이 없는 채점기는 신뢰하지 않는다).
//
// 2026-09-10 수정 전 실측 — 실제 모양 셋 모두 입력 차원이 전멸했다:
//
//   cached_tokens 없음      → input:null cache_read:null cache_write:null  issues:[input_cache_split_unconfirmed]
//   cached_tokens 만        → input:null cache_read:null cache_write:null  issues:[input_cache_split_unconfirmed]
//   reasoning 포함          → input:null cache_read:null cache_write:null  issues:[input_cache_split_unconfirmed]
//   레포 fixture(발명 필드) → input:10   cache_read:20   cache_write:10    issues:[]
//
// `issues` 가 하나라도 있으면 상태가 `priced` 가 될 수 없으므로(usage-costs.ts 의
// state 규칙), **모든 openai-chat 턴이 입력 차원에서 영구히 정산되지 않았다.**
//
// Run: node --experimental-strip-types test/openai-usage-shape.test.mjs

import './harness/loader.mjs';
import assert from 'node:assert/strict';
import { openaiRaw } from './harness/usage-costs.mjs';
const { normalizeCostUsage } = await import('../src/lib/usage-costs.ts');

const norm = (raw) => normalizeCostUsage('openai-chat', raw);
const BASE = { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 };

// ═══ 0. 계측기 확인 — 하네스 fixture 에 발명된 필드가 있다는 사실 자체를 잠근다 ══
// 이 단언이 이 파일의 출발점이다. fixture 가 조용히 "현실적인 모양" 으로 바뀌면
// 아래 단언들의 의미가 달라지므로, 지금 무엇을 쓰고 있는지 명시한다.
{
  assert.ok(
    openaiRaw.prompt_tokens_details?.cache_write_tokens !== undefined,
    '하네스 fixture 가 바뀌었다 — 이 파일의 머리말(발명된 필드)을 다시 확인하라',
  );
}

// ═══ 1. 실제 OpenAI 모양 셋이 모두 가격이 매겨진다 (양성 대조군) ════════════════
// 여기가 수정의 핵심이다. 부재를 미지로 읽지 않고 프로토콜 사실(0)로 읽는다.
{
  const cases = [
    ['캐시 미스 — prompt_tokens_details 없음', BASE, { input: 40, read: 0, write: 0 }],
    ['캐시 미스 — details 있고 cached_tokens 없음',
      { ...BASE, prompt_tokens_details: { audio_tokens: 0 } }, { input: 40, read: 0, write: 0 }],
    ['캐시 히트 — cached_tokens 만',
      { ...BASE, prompt_tokens_details: { cached_tokens: 20 } }, { input: 20, read: 20, write: 0 }],
    ['reasoning 포함',
      { ...BASE, prompt_tokens_details: { cached_tokens: 20, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 2, audio_tokens: 0 } }, { input: 20, read: 20, write: 0 }],
    ['전부 캐시 히트',
      { ...BASE, prompt_tokens_details: { cached_tokens: 40 } }, { input: 0, read: 40, write: 0 }],
  ];
  for (const [label, raw, want] of cases) {
    const r = norm(raw);
    assert.deepEqual(r.issues, [], `${label}: 가격이 안 매겨졌다 — issues=${JSON.stringify(r.issues)}`);
    assert.equal(r.meters['tokens:input'], want.input, `${label}: input`);
    assert.equal(r.meters['tokens:cache_read'], want.read, `${label}: cache_read`);
    assert.equal(r.meters['tokens:cache_write'], want.write, `${label}: cache_write`);
    assert.equal(r.meters['tokens:output'], 2, `${label}: output`);
    // 입력 차원이 전체를 정확히 나눈다 — 토큰이 사라지거나 중복되지 않는다.
    assert.equal(
      r.meters['tokens:input'] + r.meters['tokens:cache_read'] + r.meters['tokens:cache_write'],
      raw.prompt_tokens,
      `${label}: 세 입력 차원의 합이 prompt_tokens 와 다르다`,
    );
  }
}

// ═══ 2. 공급자가 cache_write 를 **보내면** 그 값을 존중한다 ════════════════════
// 0 으로 덮어쓰면 OpenAI 호환 표면을 쓰는 다른 공급자에서 과소 계량이 된다.
{
  const r = norm({ ...BASE, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 } });
  assert.deepEqual(r.issues, []);
  assert.equal(r.meters['tokens:cache_write'], 10, '공급자가 보낸 cache_write 를 버렸다');
  assert.equal(r.meters['tokens:cache_read'], 20);
  assert.equal(r.meters['tokens:input'], 10, '세 차원이 prompt_tokens 를 나눠야 한다');
  // 기존 하네스 fixture 도 같은 결과여야 한다 — 수정이 과거 동작을 바꾸지 않았다.
  const legacy = norm(openaiRaw);
  assert.deepEqual(legacy.issues, []);
  assert.equal(legacy.meters['tokens:cache_write'], 10, 'fixture 의 기존 결과가 바뀌었다');
}

// ═══ 3. 음성 대조군 — 진짜 미지는 여전히 거절한다 ══════════════════════════════
// 부재를 0 으로 읽는 것이 "아무거나 0 으로 읽는다" 가 되면 안 된다. 값이 **있는데**
// 숫자가 아니면 그건 모르는 것이고, 모르는 것을 가격 매기지 않는다.
{
  const rejected = [
    [{ ...BASE, prompt_tokens_details: { cached_tokens: 'twenty' } }, 'cached_tokens 가 문자열'],
    [{ ...BASE, prompt_tokens_details: { cached_tokens: null } }, 'cached_tokens 가 null'],
    [{ ...BASE, prompt_tokens_details: { cached_tokens: -5 } }, 'cached_tokens 가 음수'],
    [{ ...BASE, prompt_tokens_details: { cached_tokens: 1.5 } }, 'cached_tokens 가 정수 아님'],
    [{ ...BASE, prompt_tokens_details: { cache_write_tokens: 'ten' } }, 'cache_write_tokens 가 문자열'],
    [{ ...BASE, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 30 } }, 'read+write 가 input 초과'],
    [{ ...BASE, prompt_tokens: 'forty' }, 'prompt_tokens 가 문자열'],
    [{ ...BASE, prompt_tokens_details: { cached_tokens: 41 } }, 'cached_tokens 가 prompt_tokens 초과'],
  ];
  for (const [raw, why] of rejected) {
    const r = norm(raw);
    assert.ok(
      r.issues.includes('input_cache_split_unconfirmed'),
      `${why}: 모르는 값을 가격 매겼다 — issues=${JSON.stringify(r.issues)} meters=${JSON.stringify(r.meters)}`,
    );
    assert.equal(r.meters['tokens:input'], null, `${why}: input 이 null 이 아니다`);
    assert.equal(r.meters['tokens:cache_read'], null, `${why}: cache_read 가 null 이 아니다`);
    assert.equal(r.meters['tokens:cache_write'], null, `${why}: cache_write 가 null 이 아니다`);
  }
}

// ═══ 4. 오디오는 여전히 텍스트 단가로 매기지 않는다 (회귀 방지) ════════════════
// §1 이 입력 차원을 살렸으므로, 그 길로 오디오가 텍스트 가격을 타고 들어오지 않는지
// 다시 확인한다. 이건 #897 REQ-R3 이 잠근 성질이고 여기서 깨지면 안 된다.
{
  for (const [raw, why] of [
    [{ ...BASE, prompt_tokens_details: { cached_tokens: 20, audio_tokens: 7 } }, '입력 오디오'],
    [{ ...BASE, prompt_tokens_details: { cached_tokens: 20, image_tokens: 3 } }, '입력 이미지'],
  ]) {
    const r = norm(raw);
    assert.ok(r.issues.includes('non_text_tokens'), `${why}: non_text_tokens 가 없다`);
    for (const m of ['tokens:input', 'tokens:cache_read', 'tokens:cache_write']) {
      assert.equal(r.meters[m], null, `${why}: ${m} 을 텍스트 단가로 매겼다`);
    }
  }
  const outAudio = norm({ ...BASE, completion_tokens_details: { audio_tokens: 3 } });
  assert.ok(outAudio.issues.includes('non_text_tokens'));
  assert.equal(outAudio.meters['tokens:output'], null, '출력 오디오를 텍스트 단가로 매겼다');
}

// ═══ 5. token_total 검사가 살아 있다 ═══════════════════════════════════════════
{
  const bad = norm({ prompt_tokens: 40, completion_tokens: 2, total_tokens: 99 });
  assert.ok(bad.issues.includes('token_total_unconfirmed'), '합계 불일치를 놓쳤다');
  // 양성 대조군 — 맞는 합계는 이 사유를 달지 않는다.
  assert.ok(!norm(BASE).issues.includes('token_total_unconfirmed'));
}

console.log('openai-usage-shape: 실제 OpenAI 모양이 가격에 닿는다 · 공급자 값 존중 · 진짜 미지는 거절 — OK');
