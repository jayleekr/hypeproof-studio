// #897 VO-T03 — 음성 연결 계약 fixture 테스트.
//
// 이슈가 지목한 fixture 는 다섯 종류다: 정상 / 중복 / 역순 / 지연 / 알 수 없는 버전,
// 그리고 "과거 앱과 새 서버 조합". 여기에 VO-T03 의 나머지 요구("임의 새 스토어를
// 만들지 않았는지 조사 결과 첨부")를 **기계 검사**로 붙였다 — 문장으로 첨부하면
// 다음 스프린트에 테이블이 하나 생겨도 아무도 안 걸린다.
//
// verification.md 규칙 2: 양성 대조군이 핵심이다. 아래 "정상" 묶음이 없으면
// "전부 거부하는 validator" 가 음성 fixture 전부를 통과시키며 초록을 낸다.
// 스토어 스캐너에도 대조군을 붙였다 — 스캐너 자신이 틀렸는지 먼저 본다(규칙 6).
//
// ── 2026-09-10 적대적 리뷰 이후 ──────────────────────────────────────────────
// 이 파일의 첫 버전은 테스트 23개가 전부 초록이었는데, 모듈에 34종 변이를 넣어보니
// **16종이 살아남았다**고 보고됐다(그중 이름이 지목된 15종을 여기서 다시 돌려 전부
// 잡히는 것을 확인했다). "잠금" 이라고 써 놓은 파일에서 잠금 절반이 장식이었다는 뜻이다.
// 살아남은 것들의 공통점은 하나였다: 제품은 올바르게 거부하는데 **그 입력을 보내는
// fixture 가 없었다.** 특히 세 가지가 뼈아팠다.
//
//  · 허용 키 배열에 `'audio_url','transcript_text'` 를 붙여도 초록 — 이 파일이 막겠다고
//    선언한 바로 그 일(오디오/전사 유입)에 테스트가 한 줄도 없었다.
//  · reconcile 의 누적 재검증을 통째로 스텁으로 바꿔도 초록 — 그 규칙을 겨눈다던
//    fixture 가 이미 **단독으로도 불법**이라 한 줄 앞에서 잡히고 있었다.
//  · `heard` 모양 검사를 지워도 초록 — 유일한 PROVISIONAL 칸이 열려 있었다.
//
// 그래서 아래 규칙을 지킨다: **거부 assert 를 추가하면 그것과 짝이 되는 통과 assert 를
// 같이 넣는다**(`accepts`). 짝 없는 거부 묶음은 `throw new Error()` 한 줄로도 만족된다.
// 그리고 fixture 가 겨눈 규칙에 **실제로 도달하는지**를 먼저 증명한다 — 한 fixture 에
// 위반을 두 개 넣으면 다른 규칙이 먼저 걸리고, 겨눈 규칙은 한 번도 실행되지 않는다.

import './harness/loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const {
  VOICE_LINKAGE_SCHEMA,
  SUPPORTED_VOICE_LINKAGE_SCHEMAS,
  VOICE_LINKAGE_FIELD_OWNERS,
  VOICE_LINKAGE_TERMINAL_KINDS,
  VOICE_LINKAGE_EVENT_KINDS,
  VOICE_LINKAGE_RECORD_KEYS,
  VOICE_LINKAGE_EVENT_KEYS,
  VoiceLinkageError,
  validateVoiceLinkage,
  reconcileVoiceLinkage,
  voiceLinkageEventKey,
} = await import('../src/lib/voice-linkage-contract.ts');
const { validTurnId } = await import('../src/lib/request-settings.ts');
const { accessId } = await import('../src/lib/access-contracts.ts');

// ── fixture 빌더 ────────────────────────────────────────────────────────────
const TURN = 'turn-0c9f1d';
const TURN2 = 'turn-2b7e40';
const REQUEST = '0e1f2a3b:6f3c2a11-0000-4000-8000-0123456789ab'; // 콜론 포함 — 실제 usageRequestId 모양
const REQUEST2 = '0e1f2a3c:6f3c2a11-0000-4000-8000-0123456789ac';
const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);

const ev = (id, seq, kind, extra = {}) => ({ id, seq, at: 1_757_000_000_000 + seq, kind, ...extra });

const normalEvents = () => [
  ev('e1', 1, 'voice_session_open'),
  ev('e2', 2, 'turn_open', { turn_id: TURN }),
  ev('e3', 3, 'attempt_reserved', { turn_id: TURN, request_id: REQUEST }),
  ev('e4', 4, 'attempt_dispatched', { turn_id: TURN, request_id: REQUEST }),
  ev('e5', 5, 'artifact_revision', { artifact_sha256: SHA }),
  ev('e6', 6, 'turn_closed', { turn_id: TURN }),
  ev('e7', 7, 'voice_session_closed'),
];

const rec = (events = normalEvents(), over = {}) => ({
  schema: VOICE_LINKAGE_SCHEMA,
  voice_session_id: 'vs-8f2a1c',
  cohort_id: 'sk-biopharm-kids-s1',
  user_id: 'u-07',
  session_id: 'sess-2026-09-10-a',
  trial_id: '6f3c2a11-0000-4000-8000-0123456789ab',
  events,
  ...over,
});

// `assert.throws` 는 오류를 **돌려주지 않는다**(undefined). 그걸 모르고 쓰면 열두 개가
// 한꺼번에 실패하면서 제품 버그처럼 보인다 — 실제로 첫 런에서 그랬다(규칙 6: 계측기 먼저).
function caught(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof VoiceLinkageError, `VoiceLinkageError 가 아니다: ${err?.stack ?? err}`);
    return err;
  }
  assert.fail('거부해야 하는 입력이 통과했다');
}

const refuses = (value, code, status, opts) => {
  const err = caught(() => validateVoiceLinkage(value, opts));
  assert.equal(err.code, code);
  if (status !== undefined) assert.equal(err.status, status);
};

/**
 * 양성 대조군 헬퍼. **모든 `refuses` 묶음에 이것과 짝이 되는 호출이 있어야 한다** —
 * 거부 assert 만 모아두면 `throw new Error()` 한 줄로도 전부 만족된다(규칙 2).
 * 던지면 그 자리에서 스택이 보이도록 감싸지 않고 그대로 터뜨린다.
 */
const accepts = (value, opts) => validateVoiceLinkage(value, opts).record;

// ── 양성 대조군 ─────────────────────────────────────────────────────────────
// 이 묶음이 FAIL 하면 아래 음성 대조군의 초록은 전부 무의미하다.

test('양성: 정상 순서 기록을 받아들이고 내용을 바꾸지 않는다', () => {
  const input = rec();
  const { record, missing } = validateVoiceLinkage(input);
  assert.deepEqual(missing, []);
  assert.equal(record.schema, VOICE_LINKAGE_SCHEMA);
  assert.equal(record.events.length, 7);
  assert.deepEqual(record.events.map((e) => e.kind), [
    'voice_session_open', 'turn_open', 'attempt_reserved',
    'attempt_dispatched', 'artifact_revision', 'turn_closed', 'voice_session_closed',
  ]);
  // 공급자 시도 id 는 콜론을 포함한다(usageRequestId = requestId + ':' + uuid).
  // 이걸 turn_id 문법으로 검사했다면 여기서 터진다 — 짐작으로 문법을 고르지 않았다는 증거.
  assert.equal(record.events[2].request_id, REQUEST);
});

test('양성: 종단 세 종류(closed/failed/cancelled)가 모두 받아들여진다', () => {
  const tail = {
    voice_session_closed: ev('t', 8, 'voice_session_closed'),
    voice_session_failed: ev('t', 8, 'voice_session_failed', { error_code: 'provider_unavailable' }),
    voice_session_cancelled: ev('t', 8, 'voice_session_cancelled', { cancel: { attempt_dispatched: true } }),
  };
  assert.deepEqual(Object.keys(tail).sort(), [...VOICE_LINKAGE_TERMINAL_KINDS].sort());
  for (const [kind, last] of Object.entries(tail)) {
    const { record } = validateVoiceLinkage(rec([...normalEvents().slice(0, 6), last]));
    assert.equal(record.events.at(-1).kind, kind);
  }
});

test('양성: PROVISIONAL 칸은 미확정(unspecified) 상태로 실려도 통과한다', () => {
  const events = [
    ...normalEvents().slice(0, 6),
    ev('t', 8, 'voice_session_cancelled', {
      cancel: { attempt_dispatched: false, audio_interruption: 'unspecified' },
      heard: { status: 'unspecified' },
    }),
  ];
  const { record } = validateVoiceLinkage(rec(events));
  assert.equal(record.events.at(-1).cancel.audio_interruption, 'unspecified');
  assert.equal(record.events.at(-1).heard.status, 'unspecified');
});

test('양성: seq 빈 칸은 거부가 아니라 missing 으로 드러난다', () => {
  // 유실된 이벤트를 거부하면 음성 세션 하나가 통째로 버려진다. 깨끗한 기록과
  // 구분만 되면 된다 — native-observation.ts 가 missing 을 돌려주는 것과 같은 규율.
  const events = [ev('e1', 1, 'voice_session_open'), ev('e2', 4, 'turn_open', { turn_id: TURN })];
  const { missing } = validateVoiceLinkage(rec(events));
  assert.deepEqual(missing, [2, 3]);
});

test('양성: trial_id 없는(대화 밖) 음성 세션도 받아들인다', () => {
  const { record } = validateVoiceLinkage(rec(normalEvents(), { trial_id: null }));
  assert.equal(record.trial_id, null);
});

test('양성: 같은 기록 재전송은 replay — 이벤트가 늘지 않는다 (멱등성)', () => {
  const stored = rec();
  const { decision, validation } = reconcileVoiceLinkage(stored, rec());
  assert.equal(decision, 'replay');
  assert.equal(validation.record.events.length, 7);
  assert.equal(voiceLinkageEventKey('vs-8f2a1c', 'e1'), 'vs-8f2a1c:e1');
});

test('양성: 새 이벤트만 들어오면 append 하고 누적 기록을 다시 검증한다', () => {
  const stored = rec(normalEvents().slice(0, 6));
  const incoming = rec([...normalEvents().slice(0, 6), ev('e7', 7, 'voice_session_closed')]);
  const { decision, validation } = reconcileVoiceLinkage(stored, incoming);
  assert.equal(decision, 'append');
  assert.equal(validation.record.events.length, 7);
  assert.equal(validation.record.events.at(-1).kind, 'voice_session_closed');
});

test('양성: 버전 게이트는 집합 포함 검사다 — 구버전을 accept 에 넣으면 읽힌다', () => {
  // "과거 앱과 새 서버" fixture. 아직 /1 밖에 없으므로 **없던 구버전을 발명하지 않고**,
  // 판정이 하드코딩된 문자열 비교가 아니라 주입 가능한 집합 검사라는 사실만 잠근다.
  const older = rec(normalEvents(), { schema: 'hps-voice-linkage/0' });
  refuses(older, 'voice_linkage_schema_unsupported', 409); // 기본 집합에는 없다
  const { record } = validateVoiceLinkage(older, {
    accept: ['hps-voice-linkage/0', VOICE_LINKAGE_SCHEMA],
  });
  assert.equal(record.schema, 'hps-voice-linkage/0');
  assert.deepEqual([...SUPPORTED_VOICE_LINKAGE_SCHEMAS], [VOICE_LINKAGE_SCHEMA]);
});

// ── 음성 대조군: VO-T03 이 이름으로 지목한 네 fixture ───────────────────────

test('음성: 중복 이벤트 — 같은 id 가 두 번', () => {
  const events = normalEvents();
  events[3] = { ...events[3], id: 'e3' };
  refuses(rec(events), 'duplicate_voice_event_id', 409);
});

test('음성: 역순 / 같은 seq — 순서를 조용히 정렬하지 않는다', () => {
  // 계측기 주의 — 한 fixture 에 위반 두 개를 넣으면 **다른 규칙**이 먼저 걸린다.
  // 첫 시도는 reserved↔dispatched 를 뒤집었는데, 그건 순서 위반이면서 동시에
  // "예약 없는 dispatch" 이기도 해서 orphan 쪽이 먼저 잡혔다. 그래서 서로 의존이
  // 없는 두 이벤트(artifact_revision ↔ turn_closed)만 뒤집어 순서 규칙을 단독으로 겨눈다.
  const reversed = [...normalEvents()].reverse();
  assert.equal(reversed[0].kind, 'voice_session_closed'); // 전체 역순은 개시 규칙에서 먼저 걸린다
  const tailSwapped = normalEvents();
  [tailSwapped[4], tailSwapped[5]] = [tailSwapped[5], tailSwapped[4]];
  assert.deepEqual(tailSwapped.map((e) => e.seq), [1, 2, 3, 4, 6, 5, 7]);
  refuses(rec(tailSwapped), 'voice_event_sequence_out_of_order', 409);
  // 최소 fixture — 다른 규칙이 끼어들 여지가 아예 없는 모양.
  refuses(
    rec([ev('e1', 1, 'voice_session_open'), ev('e2', 3, 'turn_open', { turn_id: TURN }),
      ev('e3', 2, 'artifact_revision', { artifact_sha256: SHA })]),
    'voice_event_sequence_out_of_order', 409,
  );
  const sameSeq = normalEvents();
  sameSeq[3] = { ...sameSeq[3], seq: 3 };
  refuses(rec(sameSeq), 'voice_event_sequence_out_of_order', 409);
});

test('음성: 종단 이후 지연 이벤트', () => {
  const events = [...normalEvents(), ev('e8', 8, 'artifact_revision', { artifact_sha256: 'b'.repeat(64) })];
  refuses(rec(events), 'late_voice_event_after_terminal', 409);
});

test('음성: 알 수 없는/새로운 버전', () => {
  refuses(rec(normalEvents(), { schema: 'hps-voice-linkage/2' }), 'voice_linkage_schema_unsupported', 409);
  refuses(rec(normalEvents(), { schema: 'hps-observation/1' }), 'voice_linkage_schema_unsupported', 409);
  refuses(rec(normalEvents(), { schema: 42 }), 'voice_linkage_schema_unsupported', 409);
  // 버전 검사가 키 검사보다 **먼저** 와야 한다. 새 앱이 키를 늘려 보낸 기록은
  // "모양 오류"가 아니라 "버전 드리프트"로 보고돼야 한다.
  refuses({ ...rec(), schema: 'hps-voice-linkage/2', future_field: 1 },
    'voice_linkage_schema_unsupported', 409);
});

// ── 음성 대조군: PROVISIONAL 을 추측으로 메우는 것을 막는다 ─────────────────

test('음성: PROVISIONAL 칸에 구체값을 쓰면 거부한다', () => {
  const cancelled = (cancel) => rec([...normalEvents().slice(0, 6), ev('t', 8, 'voice_session_cancelled', { cancel })]);
  refuses(cancelled({ attempt_dispatched: true, audio_interruption: 'flush_playback' }),
    'provisional_cancel_semantics_not_settled', 409);
  const heard = rec([...normalEvents().slice(0, 6),
    ev('t', 8, 'voice_session_closed', { heard: { status: 'transcript_committed' } })]);
  refuses(heard, 'provisional_heard_not_settled', 409);
  // 확정된 쪽(dispatch 여부)은 **반드시** 있어야 한다 — 없으면 비용 증거를
  // not_sent / unknown 어느 쪽으로 적을지 결정할 수 없다.
  refuses(cancelled({ audio_interruption: 'unspecified' }), 'missing_voice_cancel_dispatch_state');
});

// ── 음성 대조군: 기존 불변식을 이름까지 그대로 재사용했는지 ─────────────────

// 코드명 재사용은 **원본에서 뽑아** 맞춘다. 첫 버전은 테스트가 직접 타이핑한 리터럴에
// 맞춰봤고, 그러면 budget-admission.ts 에서 이름을 바꿔도 이 테스트는 초록이다 —
// "기존 코드명을 그대로 재사용했다" 는 주장이 테스트로 전혀 지탱되지 않았다.
// 이 파일 아래쪽 FIELD_OWNERS 검사가 이미 쓰는 기법(원본 grep)을 여기에도 쓴다.
const BUDGET_ADMISSION = fileURLToPath(new URL('../src/lib/budget-admission.ts', import.meta.url));
const USAGE_COSTS = fileURLToPath(new URL('../src/lib/usage-costs.ts', import.meta.url));
const CONTRACT_FILE = fileURLToPath(new URL('../src/lib/voice-linkage-contract.ts', import.meta.url));
/** `dispatchBudgetAttempt` 의 "단 한 번만" 게이트가 던지는 코드를 원본에서 뽑는다. */
const DISPATCH_GATE_RE =
  /dispatchBudgetAttempt[\s\S]{0,240}?throw new AccessError\(\s*'([a-z][a-z0-9_]*)'\s*,\s*409\s*\)/;
/** `recordCostEvidence` 의 같은 불변식(not_sent 증거를 이미 dispatch 된 행에 쓰려는 경우). */
const COST_GATE_RE =
  /row\.execution_state\)\)\s*throw new AccessError\(\s*'([a-z][a-z0-9_]*)'\s*,\s*409\s*\)/;
const codeFrom = (text, re) => text.match(re)?.[1] ?? null;

test('음성: 예약 없는 dispatch, 두 번 dispatch — 코드명은 원본에서 뽑아 맞춘다', () => {
  const noReserve = normalEvents().filter((e) => e.kind !== 'attempt_reserved');
  refuses(rec(noReserve), 'orphan_voice_attempt_dispatch');

  // 추출기 자체의 대조군 먼저(규칙 6). 이름이 바뀐 원본에서는 **바뀐 이름**이,
  // 게이트가 없는 원본에서는 **null** 이 나와야 한다. 둘 중 하나라도 틀리면 아래
  // 비교는 "항상 통과하는 비교" 가 되고, 이 테스트는 다시 장식이 된다.
  assert.equal(codeFrom(
    "export async function dispatchBudgetAttempt(env,id){if(!await markUsageAttemptSent(env,id))throw new AccessError('renamed_gate_code',409);}",
    DISPATCH_GATE_RE), 'renamed_gate_code');
  assert.equal(codeFrom('export async function dispatchBudgetAttempt(env,id){return true;}', DISPATCH_GATE_RE), null);
  assert.equal(codeFrom("if(x)throw new AccessError('renamed_gate_code',409)", DISPATCH_GATE_RE), null);

  const dispatched = codeFrom(readFileSync(BUDGET_ADMISSION, 'utf8'), DISPATCH_GATE_RE);
  assert.ok(dispatched, 'budget-admission.ts 의 dispatch 게이트를 못 찾았다 — 추출기를 먼저 의심한다');
  assert.equal(codeFrom(readFileSync(USAGE_COSTS, 'utf8'), COST_GATE_RE), dispatched,
    'usage-costs.ts 와 budget-admission.ts 가 같은 불변식을 다른 이름으로 부르고 있다');

  // 같은 불변식을 다른 이름으로 부르면 운영 로그에서 버그 두 개처럼 보인다. 기대값이
  // **원본에서 온 문자열**이므로, budget-admission.ts 에서 이름을 바꾸면 여기서 터진다.
  const twice = [
    ...normalEvents().slice(0, 4),
    ev('e4b', 5, 'attempt_dispatched', { turn_id: TURN, request_id: REQUEST }),
  ];
  refuses(rec(twice), dispatched, 409);
  // 계약 파일이 그 이름을 **설명만 하고** 안 쓰는 것도 막는다.
  assert.ok(readFileSync(CONTRACT_FILE, 'utf8').includes(`'${dispatched}'`),
    `계약 파일이 ${dispatched} 를 리터럴로 쓰지 않는다`);
});

test('음성: 같은 시도 id 를 두 번 예약하지 않는다', () => {
  const head = [ev('e1', 1, 'voice_session_open'), ev('e2', 2, 'turn_open', { turn_id: TURN })];
  // 양성 — 서로 **다른** 시도 id 두 개는 같은 턴 안에서 합법이다(재시도).
  assert.equal(accepts(rec([...head,
    ev('e3', 3, 'attempt_reserved', { turn_id: TURN, request_id: REQUEST }),
    ev('e4', 4, 'attempt_reserved', { turn_id: TURN, request_id: REQUEST2 })])).events.length, 4);
  // 음성 — 같은 시도 id 를 두 번.
  refuses(rec([...head,
    ev('e3', 3, 'attempt_reserved', { turn_id: TURN, request_id: REQUEST }),
    ev('e4', 4, 'attempt_reserved', { turn_id: TURN, request_id: REQUEST })]),
  'voice_attempt_reserved_twice', 409);
  // 턴이 달라도 시도 id 는 기록 전체에서 한 번이다 — 예약은 D1 행 하나다.
  refuses(rec([...head,
    ev('e3', 3, 'attempt_reserved', { turn_id: TURN, request_id: REQUEST }),
    ev('e4', 4, 'turn_closed', { turn_id: TURN }),
    ev('e5', 5, 'turn_open', { turn_id: TURN2 }),
    ev('e6', 6, 'attempt_reserved', { turn_id: TURN2, request_id: REQUEST })]),
  'voice_attempt_reserved_twice', 409);
  // 예약은 turn_id 와 request_id 를 **둘 다** 요구한다.
  refuses(rec([...head, ev('e3', 3, 'attempt_reserved', { turn_id: TURN })]), 'missing_voice_request_id');
  refuses(rec([...head, ev('e3', 3, 'attempt_reserved', { request_id: REQUEST })]), 'orphan_voice_turn_event');
});

test('음성: 열리지 않은 턴에 붙는 이벤트, 턴 재개시, 세션 재개시', () => {
  refuses(rec(normalEvents().filter((e) => e.kind !== 'turn_open')), 'orphan_voice_turn_event');
  const reopened = [...normalEvents().slice(0, 2), ev('e2b', 3, 'turn_open', { turn_id: TURN })];
  refuses(rec(reopened), 'voice_turn_reopened', 409);
  const reSession = [...normalEvents().slice(0, 2), ev('e2c', 3, 'voice_session_open')];
  refuses(rec(reSession), 'voice_session_reopened', 409);
  refuses(rec([ev('e1', 1, 'turn_open', { turn_id: TURN })]), 'voice_session_not_opened');
});

test('음성: 문법은 기존 정의에서 가져왔다 — turn_id 와 request_id 는 다른 문법이다', () => {
  // 대조군으로 기존 함수를 직접 호출한다. request_id 는 콜론을 포함하므로
  // accessId 만 통과하고 validTurnId 는 통과하지 못한다.
  assert.equal(accessId(REQUEST), true);
  assert.equal(validTurnId(REQUEST), false);
  const badTurn = normalEvents();
  badTurn[1] = { ...badTurn[1], turn_id: REQUEST };
  refuses(rec(badTurn), 'invalid_voice_event_turn_id');
  const badRequest = normalEvents();
  badRequest[2] = { ...badRequest[2], request_id: 'has space' };
  refuses(rec(badRequest), 'invalid_voice_event_request_id');
  const badSha = normalEvents();
  badSha[4] = { ...badSha[4], artifact_sha256: 'A'.repeat(64) }; // 대문자 — SHA256_HEX_RE 는 소문자만
  refuses(rec(badSha), 'invalid_voice_artifact_revision');
  refuses(rec(normalEvents(), { trial_id: 'not-a-uuid' }), 'invalid_trial_id');
});

test('음성: 모르는 필드는 기록/이벤트 양쪽에서 막는다 (drift lock)', () => {
  refuses({ ...rec(), extra: 1 }, 'voice_linkage_unknown_field');
  const events = normalEvents();
  events[0] = { ...events[0], transcript: '안녕하세요' };
  refuses(rec(events), 'invalid_voice_event');
  // 종류에 맞지 않는 칸이 실려 오는 것도 막는다.
  const strayError = normalEvents();
  strayError[6] = { ...strayError[6], error_code: 'provider_unavailable' };
  refuses(rec(strayError), 'unexpected_voice_error_code');
  refuses(rec(normalEvents(), { events: [] }), 'invalid_voice_linkage_events');
  refuses(null, 'voice_linkage_not_an_object');
});

test('음성: 멱등 키 충돌 — 같은 id 가 다른 내용으로 다시 온다', () => {
  const stored = rec();
  const tampered = rec(normalEvents().map((e) => (e.id === 'e5' ? { ...e, artifact_sha256: 'c'.repeat(64) } : e)));
  const err = caught(() => reconcileVoiceLinkage(stored, tampered));
  assert.equal(err.code, 'voice_linkage_event_conflict');
  assert.equal(err.status, 409);
  const otherSeat = rec(normalEvents(), { user_id: 'u-08' });
  assert.equal(caught(() => reconcileVoiceLinkage(stored, otherSeat)).code, 'voice_linkage_identity_conflict');
});

test('음성: append 가 누적 기록을 불법으로 만들면 거부한다 (개별 요청은 둘 다 합법)', () => {
  // 이 파일에서 제일 까다로운 fixture 다. "이어 붙인 결과만 불법" 을 실제로 재려면
  // **저장본 단독도 합법, 수신본 단독도 합법**이어야 한다. 아니면 reconcile 첫 두 줄의
  // 개별 검증에서 먼저 걸리고, 누적 재검증이 **아예 없어도** 테스트는 초록을 낸다.
  //
  // 첫 버전이 정확히 그랬다: 수신본을 `[...normalEvents(), turn_open]` 으로 만들었는데
  // 그건 수신본 단독으로도 종단 뒤 지연이라 `validateVoiceLinkage(incoming)` 에서
  // 잡혔다. 광고한 규칙("누적 재검증")은 한 줄도 실행되지 않았다(적대적 리뷰 M7).
  // 그래서 아래 세 fixture 는 모두 `accepts()` 로 단독 합법성을 **먼저 증명**한다.

  // (1) 종단 뒤 지연 — 저장본은 이미 닫혔고, 수신본은 닫힘을 모른 채 새 턴을 연다.
  const storedClosed = rec([ev('e1', 1, 'voice_session_open'), ev('e7', 7, 'voice_session_closed')]);
  const incomingTurn = rec([ev('e1', 1, 'voice_session_open'), ev('e8', 8, 'turn_open', { turn_id: TURN2 })]);
  assert.equal(accepts(storedClosed).events.length, 2); // 저장본 단독 합법
  assert.equal(accepts(incomingTurn).events.length, 2); // 수신본 단독 합법
  assert.equal(caught(() => reconcileVoiceLinkage(storedClosed, incomingTurn)).code,
    'late_voice_event_after_terminal');

  // (2) 역순 — 저장본의 마지막 seq(5)보다 **작은** seq(3)가 새로 들어온다. 수신본만
  //     보면 1 → 3 으로 정상 증가이므로 단독 검증은 통과한다.
  const storedSparse = rec([ev('e1', 1, 'voice_session_open'), ev('e2', 5, 'turn_open', { turn_id: TURN })]);
  const incomingEarlier = rec([ev('e1', 1, 'voice_session_open'), ev('e9', 3, 'artifact_revision', { artifact_sha256: SHA })]);
  assert.deepEqual(validateVoiceLinkage(storedSparse).missing, [2, 3, 4]);
  assert.deepEqual(validateVoiceLinkage(incomingEarlier).missing, [2]);
  const err = caught(() => reconcileVoiceLinkage(storedSparse, incomingEarlier));
  assert.equal(err.code, 'voice_event_sequence_out_of_order');
  assert.equal(err.status, 409);

  // (3) 중복 예약 — 수신본만 보면 턴 열고 한 번 예약하니 합법인데, 저장본에 이미 같은
  //     시도 id 예약이 있어서 누적하면 같은 D1 예약을 두 번 주장하는 기록이 된다.
  const head = [ev('e1', 1, 'voice_session_open'), ev('e2', 2, 'turn_open', { turn_id: TURN })];
  const storedReserved = rec([...head, ev('e3', 3, 'attempt_reserved', { turn_id: TURN, request_id: REQUEST })]);
  const incomingReserved = rec([...head, ev('e4', 4, 'attempt_reserved', { turn_id: TURN, request_id: REQUEST })]);
  assert.equal(accepts(storedReserved).events.length, 3);
  assert.equal(accepts(incomingReserved).events.length, 3);
  assert.equal(caught(() => reconcileVoiceLinkage(storedReserved, incomingReserved)).code,
    'voice_attempt_reserved_twice');

  // 양성 대조군 — 누적 결과가 합법이면 append 가 되어야 한다. 이게 없으면 위 셋은
  // "reconcile 이 항상 던진다" 로도 만족된다.
  const ok = reconcileVoiceLinkage(storedReserved, rec([
    ...head,
    ev('e3', 3, 'attempt_reserved', { turn_id: TURN, request_id: REQUEST }),
    ev('e4', 4, 'attempt_dispatched', { turn_id: TURN, request_id: REQUEST }),
  ]));
  assert.equal(ok.decision, 'append');
  assert.deepEqual(ok.validation.record.events.map((e) => e.id), ['e1', 'e2', 'e3', 'e4']);
  assert.deepEqual(ok.validation.missing, []);
});

// ── 허용 키 드리프트 락: 이 파일의 **존재 이유** ─────────────────────────────
// 첫 버전에는 이 테스트가 아예 없었다. `VOICE_LINKAGE_EVENT_KEYS` 에
// `'audio_url', 'transcript_text'` 두 줄을 붙여도 23개 assert 가 전부 초록이었다
// (적대적 리뷰 M36). "앞으로 어떤 음성 코드도 식별자를 새로 만들지 못하게 막는 잠금"
// 이라고 써 놓은 파일에서, 잠금 본체에 테스트가 없었다는 뜻이다.

test('음성: 허용 키 집합이 조용히 늘어나지 않는다 — 오디오/전사 칸은 자리가 없다', () => {
  assert.deepEqual([...VOICE_LINKAGE_RECORD_KEYS], [
    'schema', 'voice_session_id', 'cohort_id', 'user_id', 'session_id', 'trial_id', 'events',
  ]);
  assert.deepEqual([...VOICE_LINKAGE_EVENT_KEYS], [
    'id', 'seq', 'at', 'kind', 'turn_id', 'request_id', 'artifact_sha256', 'error_code', 'cancel', 'heard',
  ]);
  // 배열을 통째로 갈아치우는 대신 한 칸만 추가하는 드리프트까지 잡는다. 위 deepEqual 로
  // 이미 잡히지만, 이 루프는 **왜** 막는지를 기록한다 — 오디오/전사 원문을 실을 칸을
  // 만들지 않는 것이 계약의 요점이다.
  const PAYLOAD = /audio|transcript|speech|utterance|waveform|pcm|mime|blob|bytes|base64|text/i;
  for (const key of [...VOICE_LINKAGE_RECORD_KEYS, ...VOICE_LINKAGE_EVENT_KEYS])
    assert.equal(PAYLOAD.test(key), false, `허용 키에 payload 칸이 생겼다: ${key}`);

  // 배열 pin 만으로는 "그 배열이 실제로 강제되는가" 를 못 잡는다. 런타임 결과까지 본다.
  const withAudio = normalEvents();
  withAudio[0] = { ...withAudio[0], audio_url: 'https://example.invalid/a.wav' };
  refuses(rec(withAudio), 'invalid_voice_event');
  const withTranscript = normalEvents();
  withTranscript[1] = { ...withTranscript[1], transcript_text: '학생이 말한 원문' };
  refuses(rec(withTranscript), 'invalid_voice_event');
  refuses({ ...rec(), transcript_text: '학생이 말한 원문' }, 'voice_linkage_unknown_field');
  refuses({ ...rec(), audio_url: 'https://example.invalid/a.wav' }, 'voice_linkage_unknown_field');

  // 양성 대조군 — 허용된 열 칸을 **다 쓴** 합법 기록은 통과해야 한다. 이게 없으면 위
  // 거부들은 "전부 거부하는 validator" 로도 만족된다.
  const everyKey = accepts(rec([
    ev('e1', 1, 'voice_session_open'),
    ev('e2', 2, 'turn_open', { turn_id: TURN }),
    ev('e3', 3, 'attempt_reserved', { turn_id: TURN, request_id: REQUEST }),
    ev('e4', 4, 'artifact_revision', { artifact_sha256: SHA }),
    ev('e5', 5, 'voice_session_cancelled', {
      cancel: { attempt_dispatched: false, audio_interruption: 'unspecified' },
      heard: { status: 'unspecified' },
    }),
  ]));
  const seen = new Set(everyKey.events.flatMap((e) => Object.keys(e)));
  const failing = accepts(rec([...normalEvents().slice(0, 6),
    ev('t', 8, 'voice_session_failed', { error_code: 'provider_unavailable' })]));
  for (const k of failing.events.flatMap((e) => Object.keys(e))) seen.add(k);
  assert.deepEqual([...seen].sort(), [...VOICE_LINKAGE_EVENT_KEYS].sort());
});

// ── 식별자 네 칸의 문법: 이 단위가 애초에 다루는 대상 ────────────────────────
// `validTurnId` 검사를 네 줄 다 지워도 첫 버전은 초록이었다(M31). 500자 cohort_id,
// 빈 user_id, 경로 문자가 든 session_id, 공백이 든 voice_session_id — 제품은 전부
// 올바르게 거부하는데 fixture 가 하나도 안 보냈다.

test('음성: 네 식별자는 기존 turn_id 문법을 그대로 쓴다', () => {
  // 양성 대조군 — 경계값이 통과해야 한다. 기존 정의를 직접 불러 경계를 확인한다.
  assert.equal(validTurnId('a'.repeat(128)), true);
  assert.equal(validTurnId('a'.repeat(129)), false);
  assert.equal(accepts(rec(normalEvents(), {
    voice_session_id: '7', cohort_id: 'a'.repeat(128), user_id: 'U_9-z', session_id: 'sess-2026-09-10-a',
  })).cohort_id.length, 128);

  // 음성 대조군 — 네 칸이 **각각** 따로 걸린다(한 fixture 에 한 가지 위반만 넣는다).
  refuses(rec(normalEvents(), { voice_session_id: 'has space' }), 'invalid_voice_session_id');
  refuses(rec(normalEvents(), { cohort_id: 'x'.repeat(500) }), 'invalid_cohort_id');
  refuses(rec(normalEvents(), { user_id: '' }), 'invalid_user_id');
  refuses(rec(normalEvents(), { session_id: '../../etc/passwd' }), 'invalid_session_id');
  // 문자열이 아닌 것, 줄바꿈, 키 자체가 없는 경우.
  refuses(rec(normalEvents(), { voice_session_id: 42 }), 'invalid_voice_session_id');
  refuses(rec(normalEvents(), { cohort_id: null }), 'invalid_cohort_id');
  refuses(rec(normalEvents(), { user_id: { id: 'u-07' } }), 'invalid_user_id');
  refuses(rec(normalEvents(), { session_id: 'sess\n2026' }), 'invalid_session_id');
  const noSession = rec();
  delete noSession.session_id;
  refuses(noSession, 'invalid_session_id');
});

test('음성: 이벤트 id 도 같은 문법 검사를 받는다', () => {
  const open = (id) => rec([ev(id, 1, 'voice_session_open')]);
  // 양성 — 개시 이벤트 하나뿐인 기록도 합법이다(종단을 요구하지 않는다).
  assert.equal(accepts(open('a')).events[0].id, 'a');
  assert.equal(accepts(open('a'.repeat(128))).events.length, 1);
  assert.equal(accepts(open('E_9-z')).events[0].id, 'E_9-z');
  // 음성 — 공백 / 빈 문자열 / 길이 초과 / 비문자열 / 경로 문자.
  refuses(open('has space'), 'invalid_voice_event_id');
  refuses(open(''), 'invalid_voice_event_id');
  refuses(open('a'.repeat(129)), 'invalid_voice_event_id');
  refuses(open(42), 'invalid_voice_event_id');
  refuses(open('../../etc/passwd'), 'invalid_voice_event_id');
  // 멱등 키는 `${voice_session_id}:${id}` 다. id 에 콜론이 들어가면 다른 세션의 키와
  // 겹칠 수 있으므로 문법 검사가 그걸 막는 것까지 잠근다.
  assert.equal(voiceLinkageEventKey('vs-8f2a1c', 'e1'), 'vs-8f2a1c:e1');
  refuses(open('vs-8f2a1c:e1'), 'invalid_voice_event_id');
  const noId = { ...ev('x', 1, 'voice_session_open') };
  delete noId.id;
  refuses(rec([noId]), 'invalid_voice_event_id');
});

// ── seq / at: 순서의 근거와, 근거가 아닌 것 ──────────────────────────────────

test('음성: seq 는 1..100000 안의 안전 정수다', () => {
  const second = (seq) => rec([ev('e1', 1, 'voice_session_open'), ev('e2', seq, 'artifact_revision', { artifact_sha256: SHA })]);
  // 양성 — 하한(1)과 상한(100000) 경계값이 통과한다.
  assert.equal(accepts(second(2)).events[1].seq, 2);
  assert.equal(accepts(second(100000)).events[1].seq, 100000);
  assert.equal(validateVoiceLinkage(rec([ev('e1', 1, 'voice_session_open')])).missing.length, 0);
  // 음성 — 0 / 음수 / 소수 / 상한 초과 / 비정수형 / 비안전정수 / 없음.
  // 순서 주의: 100001 을 1e9 보다 **먼저** 본다. 상한 검사가 사라진 상태에서 1e9 를
  // 먼저 보내면 빈 칸 스캔이 10억 번 돌아 테스트가 죽는다(깔끔한 실패가 아니게 된다).
  refuses(rec([ev('e1', 0, 'voice_session_open')]), 'invalid_voice_event_seq');
  refuses(rec([ev('e1', -1, 'voice_session_open')]), 'invalid_voice_event_seq');
  refuses(second(2.5), 'invalid_voice_event_seq');
  refuses(second(100001), 'invalid_voice_event_seq');
  refuses(second('2'), 'invalid_voice_event_seq');
  refuses(second(NaN), 'invalid_voice_event_seq');
  refuses(second(Number.MAX_SAFE_INTEGER + 2), 'invalid_voice_event_seq');
  const noSeq = { ...ev('e2', 2, 'turn_open', { turn_id: TURN }) };
  delete noSeq.seq;
  refuses(rec([ev('e1', 1, 'voice_session_open'), noSeq]), 'invalid_voice_event_seq');
});

test('음성: at 은 유한수여야 한다 — 그리고 계약은 그것만 주장한다', () => {
  const withAt = (at) => rec([{ id: 'e1', seq: 1, at, kind: 'voice_session_open' }]);
  // 양성 — 0도, 음수도, 소수도 유한수다. 시각의 범위는 계약이 주장하지 않는다
  // (순서의 근거는 seq 뿐이라고 써 놓았으므로, 그 약속까지 같이 잠근다).
  assert.equal(accepts(withAt(0)).events[0].at, 0);
  assert.equal(accepts(withAt(-1)).events[0].at, -1);
  assert.equal(accepts(withAt(1.5)).events[0].at, 1.5);
  // 음성 — NaN / ±Infinity / 문자열 / null / 없음.
  refuses(withAt(NaN), 'invalid_voice_event_at');
  refuses(withAt(Infinity), 'invalid_voice_event_at');
  refuses(withAt(-Infinity), 'invalid_voice_event_at');
  refuses(withAt('1757000000000'), 'invalid_voice_event_at');
  refuses(withAt(null), 'invalid_voice_event_at');
  refuses(rec([{ id: 'e1', seq: 1, kind: 'voice_session_open' }]), 'invalid_voice_event_at');
});

test('음성: 이벤트 수 상한 2000 — 기록 하나가 무한히 길어지지 않는다', () => {
  const filler = (n) => Array.from({ length: n }, (_, i) => ev(`a${i}`, i + 2, 'artifact_revision', { artifact_sha256: SHA }));
  // 양성 — 정확히 상한(2000)은 통과한다. 경계가 2000 이 아니라 1999 였다면 여기서 터진다.
  const atCap = rec([ev('e1', 1, 'voice_session_open'), ...filler(1999)]);
  assert.equal(atCap.events.length, 2000);
  assert.equal(accepts(atCap).events.length, 2000);
  // 음성 — 하나만 넘어도 거부한다.
  const overCap = rec([ev('e1', 1, 'voice_session_open'), ...filler(2000)]);
  assert.equal(overCap.events.length, 2001);
  refuses(overCap, 'invalid_voice_linkage_events');
  refuses(rec(normalEvents(), { events: {} }), 'invalid_voice_linkage_events');
  refuses(rec(normalEvents(), { events: 'e1' }), 'invalid_voice_linkage_events');
});

test('성능: 빈 칸 스캔 비용이 이벤트 수에 비례해 폭발하지 않는다', () => {
  // 빈 칸 스캔은 `previousSeq` 번 돈다. `seqs` 가 **배열**이면 매 바퀴 `includes` 가
  // 이벤트 전체를 훑으므로 비용이 `previousSeq × events.length` 가 되고, 두 값 모두
  // 클라이언트가 고른다. 두 상한(이벤트 2000 / seq 100000) 안의 **합법** 입력 하나가
  // worker CPU 를 ~34ms 태웠다(이 기계 측정). Set 이면 ~3ms 다.
  //
  // 계측기 주의 1 — 적대적 리뷰는 "이벤트 2개로 큰 seq" 가 100ms+ 라고 했지만 그 모양은
  // **1.6ms** 다(`includes` 가 2칸 배열을 훑으므로 거의 공짜다). 비용은 두 값의 **곱**
  // 이므로 느려지는 모양을 만들려면 둘 다 키워야 한다. 그 보고를 그대로 믿고 2-이벤트
  // fixture 를 썼다면 이 테스트는 고친 코드와 안 고친 코드를 구분하지 못했을 것이다.
  //
  // 계측기 주의 2 — 절대 시간 임계값(`best < 30ms`)을 먼저 썼는데, 고친 쪽 3ms 와 안
  // 고친 쪽 34ms 사이에 임계값을 두면 느린 기계에서 오경보가 난다. 그래서 **같은
  // seq 상한에서 이벤트 수만 100배 차이나는 두 입력의 비율**로 바꿨다 — 기계 속도가
  // 약분된다. 측정: Set 1.3~1.8배 / 배열 17.6~18.4배. 임계 5배는 양쪽에 3배 여유다.
  const build = (n) => {
    const stride = Math.floor(100000 / n);
    const events = [ev('s0', stride, 'voice_session_open')];
    for (let i = 1; i < n; i++) events.push(ev(`s${i}`, stride * (i + 1), 'artifact_revision', { artifact_sha256: SHA }));
    return rec(events);
  };
  const many = build(2000); // 이벤트 2000개 = 상한, 마지막 seq 100000 = 상한
  const few = build(20);    // 이벤트 20개, 마지막 seq 100000 — 빈 칸 스캔 길이는 같다
  assert.equal(many.events.length, 2000);
  assert.equal(many.events.at(-1).seq, 100000);
  assert.equal(few.events.at(-1).seq, 100000);

  // 결정적 부분이 본체다 — 시간은 보조 지표다.
  const { missing } = validateVoiceLinkage(many);
  assert.equal(missing.length, 100000 - 2000);
  assert.equal(missing[0], 1);
  assert.equal(missing.at(-1), 99999);

  // 노이즈는 시간을 **늘리기만** 하므로 3회 최소값으로 본다. 비율을 재기 전에 양쪽을
  // 한 번 돌려 JIT 를 같은 상태로 만든다(안 하면 먼저 돈 쪽이 손해를 본다).
  const best = (input) => {
    let b = Infinity;
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      validateVoiceLinkage(input);
      b = Math.min(b, performance.now() - t0);
    }
    return b;
  };
  best(few); best(many);
  const ratio = best(many) / best(few);
  assert.ok(ratio < 5,
    `빈 칸 스캔이 이벤트 수에 비례한다 (배열 includes 패턴): ${ratio.toFixed(1)}배 ` +
    '(측정 기준 Set ~1.5배 / 배열 ~18배)');
});

// ── 종류별 게이트: 코드는 맞는데 fixture 가 없던 칸들 ────────────────────────

test('음성: 세션 개시 이벤트는 턴/시도 식별자를 들고 올 수 없다', () => {
  // 양성 — 식별자 없이 오면 통과한다.
  assert.equal(accepts(rec()).events[0].kind, 'voice_session_open');
  const open = (extra) => rec([ev('e1', 1, 'voice_session_open', extra), ev('e2', 2, 'turn_open', { turn_id: TURN })]);
  assert.equal(accepts(open({})).events.length, 2);
  // 음성 — 턴/시도 식별자를 들고 오면 거부한다. 세션은 턴보다 **위** 단위다.
  refuses(open({ turn_id: TURN }), 'voice_session_open_carries_turn');
  refuses(open({ request_id: REQUEST }), 'voice_session_open_carries_turn');
  refuses(open({ turn_id: TURN, request_id: REQUEST }), 'voice_session_open_carries_turn');
});

test('음성: turn_closed 도 열린 턴을 요구한다 (게이트에 실제로 도달하는 fixture)', () => {
  // 계측기 주의 — 기존 orphan fixture 는 `turn_open` 을 지워서 `attempt_reserved` 가
  // 먼저 걸린다. `turn_closed` 자신의 게이트는 그 fixture 로는 **도달하지 않는다**
  // (적대적 리뷰 M35). 그래서 예약/디스패치가 아예 없는 모양으로 따로 겨눈다.
  const openEv = ev('e1', 1, 'voice_session_open');
  // 양성 — 열고 닫으면 통과한다.
  assert.equal(accepts(rec([openEv, ev('e2', 2, 'turn_open', { turn_id: TURN }),
    ev('e3', 3, 'turn_closed', { turn_id: TURN })])).events.length, 3);
  // 양성 — 열린 턴을 닫지 않고 세션을 끝내는 것은 **위반이 아니다**. 계약이 그걸
  // 주장하지 않는다는 사실까지 잠근다(없는 규칙을 나중에 추측으로 넣지 못하게).
  assert.equal(accepts(rec([...normalEvents().slice(0, 5),
    ev('e7', 7, 'voice_session_closed')])).events.at(-1).kind, 'voice_session_closed');
  // 음성 — 열리지 않은 턴 / 다른 턴 / 두 번 닫기 / turn_id 없음.
  refuses(rec([openEv, ev('e2', 2, 'turn_closed', { turn_id: TURN })]), 'orphan_voice_turn_event');
  refuses(rec([openEv, ev('e2', 2, 'turn_open', { turn_id: TURN }),
    ev('e3', 3, 'turn_closed', { turn_id: TURN2 })]), 'orphan_voice_turn_event');
  refuses(rec([openEv, ev('e2', 2, 'turn_open', { turn_id: TURN }),
    ev('e3', 3, 'turn_closed', { turn_id: TURN }),
    ev('e4', 4, 'turn_closed', { turn_id: TURN })]), 'orphan_voice_turn_event');
  refuses(rec([openEv, ev('e2', 2, 'turn_closed')]), 'orphan_voice_turn_event');
});

test('음성: error_code 는 코드다 — 학생 텍스트·공급자 원문이 이 칸으로 새지 않는다', () => {
  const failed = (extra) => rec([...normalEvents().slice(0, 6), ev('t', 8, 'voice_session_failed', extra)]);
  // 양성 — 코드 문법 경계값(1자, 64자, 숫자·밑줄 포함).
  assert.equal(accepts(failed({ error_code: 'provider_unavailable' })).events.at(-1).error_code, 'provider_unavailable');
  assert.equal(accepts(failed({ error_code: 'a' })).events.at(-1).error_code, 'a');
  assert.equal(accepts(failed({ error_code: 'a'.repeat(64) })).events.at(-1).error_code.length, 64);
  assert.equal(accepts(failed({ error_code: 'e5_provider_500' })).events.at(-1).error_code, 'e5_provider_500');
  // 음성 — **한국어 자유 텍스트**가 이 칸의 주된 위험이다. 규칙의 목적이 그것이므로
  // fixture 도 그걸 보낸다(첫 버전은 이걸 한 번도 보내지 않았다: 적대적 리뷰 M20).
  refuses(failed({ error_code: '공급자가 응답하지 않았어요' }), 'invalid_voice_error_code');
  refuses(failed({ error_code: '학생이 마이크를 껐어요. 다시 시도할까요?' }), 'invalid_voice_error_code');
  refuses(failed({ error_code: 'Provider Unavailable' }), 'invalid_voice_error_code');
  refuses(failed({ error_code: 'provider unavailable' }), 'invalid_voice_error_code');
  refuses(failed({ error_code: 'provider.unavailable!' }), 'invalid_voice_error_code');
  refuses(failed({ error_code: '' }), 'invalid_voice_error_code');
  refuses(failed({ error_code: 'a'.repeat(65) }), 'invalid_voice_error_code');
  refuses(failed({ error_code: '9_starts_with_digit' }), 'invalid_voice_error_code');
  refuses(failed({ error_code: 42 }), 'invalid_voice_error_code');
  // failed 인데 코드를 안 들고 오면 "왜 실패했는지 모르는 기록" 이 남는다.
  refuses(failed({}), 'invalid_voice_error_code');
});

test('음성: 종류에 맞지 않는 칸 — cancel 과 artifact_sha256 도 error_code 처럼 막는다', () => {
  // 양성 — 제 종류에 실리면 통과한다.
  assert.equal(accepts(rec()).events[4].artifact_sha256, SHA);
  assert.equal(accepts(rec([...normalEvents().slice(0, 6),
    ev('t', 8, 'voice_session_cancelled', { cancel: { attempt_dispatched: true } })]))
    .events.at(-1).cancel.attempt_dispatched, true);
  // 음성 — cancel 이 취소 아닌 이벤트에 실린다(개시·턴·종료 전부).
  for (const i of [0, 1, 2, 3, 4, 5, 6]) {
    const stray = normalEvents();
    stray[i] = { ...stray[i], cancel: { attempt_dispatched: true } };
    refuses(rec(stray), 'unexpected_voice_cancel');
  }
  // 음성 — artifact_sha256 이 artifact_revision(인덱스 4) 아닌 이벤트에 실린다.
  for (const i of [0, 1, 2, 3, 5, 6]) {
    const stray = normalEvents();
    stray[i] = { ...stray[i], artifact_sha256: SHA2 };
    refuses(rec(stray), 'unexpected_voice_artifact_revision');
  }
  // cancel 의 모양 자체도 잠겨 있다 — 새 칸을 달거나 객체가 아니면 거부한다.
  const badCancel = (cancel) => rec([...normalEvents().slice(0, 6), ev('t', 8, 'voice_session_cancelled', { cancel })]);
  refuses(badCancel({ attempt_dispatched: true, transcript: '학생 음성 원문' }), 'invalid_voice_cancel');
  refuses(badCancel(true), 'invalid_voice_cancel');
  refuses(badCancel([]), 'invalid_voice_cancel');
  refuses(badCancel(null), 'invalid_voice_cancel');
  refuses(badCancel({ attempt_dispatched: 'true' }), 'missing_voice_cancel_dispatch_state');
});

test('음성: heard 는 PROVISIONAL 자리다 — 모양까지 잠겨 있다', () => {
  // `heard` 는 이 계약에서 유일하게 "모델이 들은 것" 을 가리키는 칸이다. 모양이
  // 풀려 있으면 오디오/전사 원문이 들어올 틈이 바로 여기다(적대적 리뷰 M15).
  const heard = (h) => rec([...normalEvents().slice(0, 6), ev('t', 8, 'voice_session_closed', { heard: h })]);
  // 양성 — 유일하게 허용된 모양.
  assert.equal(accepts(heard({ status: 'unspecified' })).events.at(-1).heard.status, 'unspecified');
  // 음성 — 칸을 더 달면 거부한다.
  refuses(heard({ status: 'unspecified', transcript: '학생 음성 원문' }), 'invalid_voice_heard');
  refuses(heard({ status: 'unspecified', audio_url: 'https://example.invalid/a.wav' }), 'invalid_voice_heard');
  refuses(heard({ status: 'unspecified', confidence: 0.91 }), 'invalid_voice_heard');
  // 음성 — 객체가 아니면 거부한다. 문자열 `'unspecified'` 가 특히 지나가기 쉽다.
  refuses(heard('unspecified'), 'invalid_voice_heard');
  refuses(heard(null), 'invalid_voice_heard');
  refuses(heard([]), 'invalid_voice_heard');
  refuses(heard(true), 'invalid_voice_heard');
  // 음성 — 모양은 맞지만 값이 추측이면 409(버전·의미 드리프트 팔레트).
  refuses(heard({}), 'provisional_heard_not_settled', 409);
  refuses(heard({ status: '학생이 이렇게 말했다' }), 'provisional_heard_not_settled', 409);
  refuses(heard({ status: 'transcript_committed' }), 'provisional_heard_not_settled', 409);
});

// ── VO-T03: "임의 새 스토어를 만들지 않았다" 를 기계로 확인한다 ──────────────

const WORKER_SRC = fileURLToPath(new URL('../src/', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const SELF = 'lib/voice-linkage-contract.ts';

const filesUnder = (root, exts) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && exts.some((x) => d.name.endsWith(x)))
    .map((d) => path.join(d.parentPath ?? d.path, d.name));

/**
 * 스캐너가 **실제로 재는 것** — 여기서 과장하면 초록이 거짓말이 된다.
 *
 *   잡는다:   테이블 이름, 그리고 문자열/템플릿 리터럴 **맨 앞**의 KV 네임스페이스
 *             경로에 `voice|audio|speech|transcript|utterance` 토큰이 있는 경우.
 *   못 잡는다: 이름에 그 토큰이 하나도 없는 스토어 — `realtime_sessions`,
 *             `rt:sess:` 같은 것. 이름 스캔의 원리적 한계다.
 *
 * 못 잡는 쪽을 덮는 것은 이 스캐너가 아니라 **허용 키 드리프트 락**이다
 * (`VOICE_LINKAGE_RECORD_KEYS` / `VOICE_LINKAGE_EVENT_KEYS` / `VOICE_LINKAGE_FIELD_OWNERS`).
 * 새 스토어는 키로 쓸 식별자가 필요하고, 새 식별자는 저 셋 중 하나를 반드시 건드린다.
 * 그래서 "임의 새 스토어 없음" 이라는 주장은 이 스캐너 **혼자서는** 지탱되지 않는다.
 *
 * `(?<![a-z])` 가 핵심이다. 이게 없으면 기존 `usage_invoice_adjustments` 가
 * **invoice 안의 "voice"** 때문에 전부 걸린다 — 이 레포에서 한 글자 정규식이
 * 오판을 낸 전례가 그대로 재현된다. 그래서 아래에 스캐너 자체의 대조군을 둔다.
 */
const STORE_TOKEN = /(?<![a-z])(voice|audio|speech|transcript|utterance)/i;
function voiceTablesIn(sql) {
  const hits = [];
  const re = /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|JOIN)\s+`?([A-Za-z_][A-Za-z0-9_]*)`?/gi;
  for (const m of sql.matchAll(re)) if (STORE_TOKEN.test(m[1])) hits.push(m[1]);
  return hits;
}

/**
 * KV 네임스페이스. 이 레포의 키는 전부 `<prefix>:`(때로 `<prefix>:<sub>:`)로 **시작하는**
 * 리터럴이다 — kv.ts 의 `cohort:${id}:roster`·`revoked:${jti}`, liveness.ts 의
 * `live:af:${c}:${u}`, modules.ts 의 `module:${kind}:…`. 그래서 따옴표/백틱 **바로 뒤**의
 * 네임스페이스 경로만 본다.
 *
 * 첫 버전은 `(live|cohort|rate):` 로 좁혀놨다. 그러면 새 **최상위** 접두사가 그대로
 * 통과한다 — 적대적 리뷰가 `voice:sess:`·`voice:turn:`·`voicelog:` 세 개를 src/lib 에
 * 심고 스위트를 초록으로 통과시켰다. 그게 이 파일이 막겠다고 선언한 바로 그 일이다.
 */
const KV_NAMESPACE_RE = /(['"`])([a-z][a-z0-9_]*(?::[a-z0-9_]*)+)/g;
function voiceKvNamespacesIn(text) {
  const hits = [];
  for (const m of text.matchAll(KV_NAMESPACE_RE)) if (STORE_TOKEN.test(m[2])) hits.push(m[2]);
  return hits;
}

test('스캐너 대조군: invoice 는 안 걸리고, 새 최상위 접두사는 걸린다', () => {
  // 양성 대조군 — 확실히 **정상**인 시료가 통과해야 한다. 여기가 빨개지면 아래
  // VO-T03 검사는 "무엇이든 걸리는 스캐너" 로 초록을 못 낸다(규칙 2).
  assert.deepEqual(voiceTablesIn('INSERT INTO usage_invoice_adjustments (request_id) VALUES (?)'), []);
  assert.deepEqual(voiceTablesIn("SELECT 1 FROM usage_invoice_adjustments x WHERE x.invoice_ref=''"), []);
  assert.deepEqual(voiceKvNamespacesIn('const k = `cohort:${id}:roster`'), []);
  assert.deepEqual(voiceKvNamespacesIn('const k = `live:af:${c}:${u}`'), []);
  assert.deepEqual(voiceKvNamespacesIn('const k = `currency:${q.currency}:micro`'), []);
  assert.deepEqual(voiceKvNamespacesIn('write(`data: ${payload}`)'), []);
  assert.deepEqual(voiceKvNamespacesIn('const k = `invoice:${id}:line`'), []); // invoice 안의 voice
  // 음성 대조군 — 확실히 **위반**인 시료가 걸려야 한다.
  assert.deepEqual(voiceTablesIn('CREATE TABLE IF NOT EXISTS voice_sessions (id TEXT)'), ['voice_sessions']);
  assert.deepEqual(voiceTablesIn('INSERT INTO voice_turns (id) VALUES (?)'), ['voice_turns']);
  assert.deepEqual(voiceTablesIn('SELECT * FROM voice_linkage_records'), ['voice_linkage_records']);
  assert.deepEqual(voiceTablesIn('CREATE TABLE utterances (id TEXT)'), ['utterances']);
  assert.deepEqual(voiceTablesIn('CREATE TABLE audio_chunks (id TEXT)'), ['audio_chunks']);
  // 적대적 리뷰가 실제로 통과시킨 probe 세 종. 이 셋이 다시 []가 되면 스캐너가 퇴행했다.
  assert.deepEqual(voiceKvNamespacesIn('export const k = (id:string) => `voice:sess:${id}`'), ['voice:sess:']);
  assert.deepEqual(voiceKvNamespacesIn('export const k = (id:string) => `voice:turn:${id}`'), ['voice:turn:']);
  assert.deepEqual(voiceKvNamespacesIn('export const k = (id:string) => `voicelog:${id}`'), ['voicelog:']);
  assert.deepEqual(voiceKvNamespacesIn('const k = `audio:chunk:${id}`'), ['audio:chunk:']);
  assert.deepEqual(voiceKvNamespacesIn("const k = 'transcript:rev:'"), ['transcript:rev:']);
  // 못 잡는 것을 **명시**해 둔다. 여기가 초록인데도 "임의 새 스토어 없음" 을 이 스캐너
  // 하나로 주장하면 그게 과장이다 — 위 주석의 범위 설명이 이 세 줄로 잠긴다.
  assert.deepEqual(voiceTablesIn('CREATE TABLE realtime_sessions (id TEXT)'), []);
  assert.deepEqual(voiceKvNamespacesIn('const k = `rt:sess:${id}`'), []);
  assert.deepEqual(voiceTablesIn('CREATE TABLE utter_log (id TEXT)'), []);
});

test('VO-T03: 이름에 voice/audio 계열 토큰이 든 테이블·KV 네임스페이스가 없다', () => {
  const offenders = [];
  for (const file of [...filesUnder(WORKER_SRC, ['.ts']), ...filesUnder(MIGRATIONS, ['.sql'])]) {
    const text = readFileSync(file, 'utf8');
    for (const table of voiceTablesIn(text)) offenders.push(`${file}: table ${table}`);
    // KV 네임스페이스도 같이 본다 — liveness.ts 가 `live:af:` 로 하는 것처럼 조용히
    // 새 네임스페이스를 파는 쪽이 D1 테이블보다 훨씬 쉽다(마이그레이션 게이트가 없다).
    for (const ns of voiceKvNamespacesIn(text)) offenders.push(`${file}: kv ${ns}`);
  }
  assert.deepEqual(offenders, []);
});

test('VO-T03: 모든 식별자가 이미 존재하는 스토어를 소유자로 지목한다', () => {
  const sources = filesUnder(WORKER_SRC, ['.ts'])
    .filter((f) => !f.endsWith(SELF) && !f.split(path.sep).join('/').endsWith(SELF))
    .map((f) => readFileSync(f, 'utf8'));
  const entries = Object.entries(VOICE_LINKAGE_FIELD_OWNERS);
  assert.ok(entries.length >= 8, '식별자 소유자 표가 비어 있으면 이 검사는 공수표다');
  for (const [field, owner] of entries) {
    assert.ok(owner.store.length > 0, `${field}: store 설명이 없다`);
    assert.ok(
      sources.some((s) => s.includes(owner.evidence)),
      `${field}: 소유자 증거 리터럴 ${JSON.stringify(owner.evidence)} 가 worker/src 에 없다 — ` +
        '스토어가 사라졌거나 애초에 없는 것을 적었다',
    );
  }
  // 계측기 대조군: 없는 리터럴은 **반드시** 실패해야 한다. 이게 없으면 위 루프는
  // `includes` 가 항상 true 인 버그에도 초록을 낸다.
  assert.equal(sources.some((s) => s.includes('hps_voice_session_store_v1')), false);
});

test('계약 표면이 조용히 늘어나지 않는다', () => {
  assert.deepEqual([...VOICE_LINKAGE_EVENT_KINDS], [
    'voice_session_open', 'turn_open', 'attempt_reserved', 'attempt_dispatched',
    'artifact_revision', 'turn_closed',
    'voice_session_closed', 'voice_session_failed', 'voice_session_cancelled',
  ]);
  assert.deepEqual(Object.keys(VOICE_LINKAGE_FIELD_OWNERS), [
    'voice_session_id', 'cohort_id', 'user_id', 'session_id',
    'trial_id', 'turn_id', 'request_id', 'artifact_sha256',
  ]);
});
