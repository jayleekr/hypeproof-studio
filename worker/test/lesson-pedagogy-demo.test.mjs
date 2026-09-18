// 데모용 복제 픽스처를 관문에 태운다 (#1116).
//
// 여기 있는 자료는 전부 **데모용 복제**다. 운영 데이터가 아니고 실적으로 인용할 수 없다.
// 각 픽스처가 그 고지와 출처를 갖고 있는지를 이 파일이 **기계적으로 강제한다** — 고지가
// 빠진 픽스처는 여기서 실패한다. 나중에 누가 이걸 실제 기록으로 착각하는 것이 이 자산의
// 가장 큰 위험이라, 사람이 기억하는 대신 테스트가 기억하게 둔다.
//
// 픽스처는 `hps-demo-fixture/1` 봉투다. session-design 스키마가 엄격한 키 화이트리스트라
// 고지를 content 안에 넣을 수 없어서, 메타데이터를 바깥에 두고 content는 순수한 수업으로
// 남긴다 — 그래야 관문 판정이 실제 수업에 대한 판정이 된다.
//
// 기대값은 `expect.blocked`(차단되는가)와 선택적 `expect.firing`(발화하는 검사 집합)이다.
// 정답을 픽스처에 심어 두고 세는 방식이라, 관문이 고장나면 즉시 드러난다
// (.claude/rules/verification.md 규칙 3).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { checkLessonPedagogy, blockingPedagogyFindings } = await import('../src/lib/lesson-pedagogy.ts');
const { validateSessionDesign } = await import('../src/lib/session-design.ts');

const dir = new URL('./fixtures/lesson-pedagogy/', import.meta.url);
const files = readdirSync(fileURLToPath(dir)).filter(f => f.endsWith('.demo.json')).sort();
assert.ok(files.length, '데모 픽스처가 하나도 없다');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const firing = fs => fs.filter(f => !f.skipped).map(f => f.check).sort();

const loaded = files.map(f => [f, JSON.parse(readFileSync(new URL(f, dir), 'utf8'))]);

// ── 오독 방지 고지는 선택이 아니다 ──────────────────────────────────────────
for (const [file, fx] of loaded) {
  check(`${file}: 데모용 복제 고지와 출처가 있다`, () => {
    assert.equal(fx.schema, 'hps-demo-fixture/1', '봉투 스키마');
    assert.ok(fx.demo_notice && fx.demo_notice.includes('데모용 복제'), '데모용 복제 고지 필요');
    assert.ok(/실적/.test(fx.demo_notice), '실적으로 인용할 수 없다는 문구 필요');
    for (const k of ['path', 'kind', 'status', 'ip_owner']) {
      assert.ok(fx.source?.[k], `source.${k} 필요 — 출처와 원본 상태를 적는다`);
    }
    assert.ok(Array.isArray(fx.courses) && fx.courses.length, 'courses 필요');
    assert.equal(typeof fx.expect?.blocked, 'boolean', 'expect.blocked 필요 — 정답을 심고 시작한다');
  });
}

// ── 형태 검증은 관문보다 먼저다 ─────────────────────────────────────────────
// freeze 경로는 validateSessionDesign 이 먼저 돌고 관문은 그 뒤다. 원문에 완료 기준과
// 목표가 아예 없는 자료는 **관문에 도달하기 전에** 형태 검증에서 막힌다 — 그 사실을
// 숨기지 않고 픽스처가 `expect.shape_error` 로 선언하게 한다. 관문 판정은 순수 함수로
// 따로 계산한다(그 함수는 freeze 전용이 아니다).
for (const [file, fx] of loaded) {
  const want = fx.expect.shape_error === true;
  check(`${file}: 형태 검증 결과가 선언과 같다 (shape_error=${want})`, () => {
    for (const c of fx.courses) {
      const err = validateSessionDesign(c.content, true);
      if (want) assert.ok(err, `${c.course_id}: 형태 오류를 선언했는데 통과했다`);
      else assert.equal(err, null, `${c.course_id}: ${err}`);
    }
  });
}

// ── 관문 판정이 심어 둔 정답과 맞는가 ───────────────────────────────────────
for (const [file, fx] of loaded) {
  check(`${file}: 관문 판정이 기대와 일치한다 (blocked=${fx.expect.blocked})`, () => {
    for (const c of fx.courses) {
      const findings = checkLessonPedagogy(c.content);
      const blocked = blockingPedagogyFindings(findings).length > 0;
      assert.equal(blocked, fx.expect.blocked,
        `${c.course_id}: blocked=${blocked}, 판정=${JSON.stringify(findings.filter(f => f.severity === 'fail'), null, 1)}`);
      if (fx.expect.firing) {
        assert.deepEqual(firing(findings), [...fx.expect.firing].sort(),
          `${c.course_id}: 발화한 검사 집합이 다르다`);
      }
      // 차단이든 통과든 모든 판정은 다음 행동을 지목해야 한다. 거절만 하는 관문은 쓸모가 없다.
      for (const f of findings) assert.ok(f.remedy?.trim(), `${c.course_id}/${f.check}: remedy 비어 있음`);
    }
  });
}

// ── 차단본과 해소본은 "채운 칸"만 달라야 한다 ───────────────────────────────
// `resolves` 로 연결된 픽스처 쌍은 같은 수업이어야 한다 — 다른 수업을 가져다 놓고
// "고쳤다"고 보이는 것이 이 시연에서 가장 쉬운 거짓말이다.
const byId = new Map(loaded.map(([, fx]) => [fx.id, fx]));
for (const [file, fx] of loaded) {
  if (!fx.resolves) continue;
  check(`${file}: 해소본이 차단본에서 채운 칸만 다르다`, () => {
    const before = byId.get(fx.resolves);
    assert.ok(before, `resolves 대상 ${fx.resolves} 픽스처가 없다`);
    assert.equal(before.expect.blocked, true, '해소본은 차단본을 가리켜야 한다');
    assert.equal(fx.expect.blocked, false, '해소본은 통과해야 한다');
    assert.equal(fx.courses.length, before.courses.length, '수업 수가 같아야 한다');
    for (const [i, after] of fx.courses.entries()) {
      const prev = before.courses[i];
      assert.equal(after.course_id, prev.course_id, '같은 수업이어야 한다');
      assert.deepEqual(after.content.steps.map(s => s.id), prev.content.steps.map(s => s.id),
        '단계 구성이 같아야 한다 — 단계를 갈아끼운 것은 해소가 아니다');
      // 채워진 칸은 이전에 비어 있던 칸이어야 한다. 이미 있던 내용을 바꾼 것은 해소가 아니다.
      const blank = v => typeof v !== 'string' || !v.trim();
      for (const k of ['title', 'audience', 'objective', 'starter']) {
        if (after.content[k] !== prev.content[k]) {
          assert.ok(blank(prev.content[k]), `${k}: 비어 있지 않던 값을 바꿨다`);
        }
      }
      for (const [j, s] of after.content.steps.entries()) {
        const p = prev.content.steps[j];
        for (const k of ['title', 'instructions', 'hint', 'acceptance']) {
          if (s[k] !== p[k]) assert.ok(blank(p[k]) || k === 'instructions',
            `step ${s.id}.${k}: 비어 있지 않던 값을 바꿨다`);
        }
      }
    }
  });
}

console.log(`lesson-pedagogy-demo: ${passed} checks passed · 픽스처 ${files.length}개 — ${files.join(', ')}`);
console.log('이 자료는 데모용 복제다. 운영 기록도 실적도 아니다.');
