// Task E — 클라이언트 하트비트 스케줄러 + artifactChanged 게이트.
//
// vscode 없이 순수 Node 로 돈다 (sessionSpool/spoolUploader 와 같은 규율).
// 페이로드 모양의 워커 정합은 worker/test/liveness-trace.test.mjs 의 드리프트
// 락이 잡는다 — 여기서는 **언제 보내고 언제 멈추는가**만 본다.
//
// Run: node --experimental-strip-types test/heartbeat.smoke.mjs

import assert from "node:assert/strict";
import {
  ArtifactChangeGate,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_BACKOFF_TICKS,
  buildArtifactChangedEvent,
  buildHeartbeatEvent,
  startHeartbeat,
} from "../src/heartbeat.ts";

/** 타이머를 손으로 돌리는 스케줄러 — 실제 45초를 기다리지 않는다. */
function harness({ responses = [] } = {}) {
  const sent = [];
  let idle = 0;
  let fn = null;
  let cleared = false;
  const logs = [];
  const stoppedCalls = [];
  const pinger = startHeartbeat({
    onStopped: () => stoppedCalls.push(Date.now()),
    send: async (ev) => {
      sent.push(ev);
      return responses.shift() ?? { ok: true, status: 200 };
    },
    idleMs: () => idle,
    setInterval: (f) => {
      fn = f;
      return "handle";
    },
    clearInterval: (h) => {
      assert.equal(h, "handle");
      cleared = true;
    },
    log: (l) => logs.push(l),
  });
  return {
    pinger,
    sent,
    logs,
    stoppedCalls,
    setIdle: (v) => (idle = v),
    isCleared: () => cleared,
    hasTimer: () => fn !== null,
  };
}

// ─── 간격은 사양 창(30~60초) 안이다 ────────────────────────────────────────
{
  assert.ok(
    HEARTBEAT_INTERVAL_MS >= 30_000 && HEARTBEAT_INTERVAL_MS <= 60_000,
    "핑 간격 30~60초 (dag.yaml acceptance)",
  );
  console.log("✓ 간격 — 30~60초");
}

// ─── 양성 — 채팅과 무관하게 계속 보낸다. 그게 이 기능의 존재 이유다 ─────────
{
  const h = harness();
  h.setIdle(5_000);
  await h.pinger.tick();
  await h.pinger.tick();
  await h.pinger.tick();
  assert.equal(h.sent.length, 3, "아무 채팅 없이도 세 번 나갔다");
  assert.deepEqual(h.sent[0], { type: "heartbeat", idle_ms: 5_000 });

  // 오래 조용해도 **판정은 하지 않는다** — 관측값만 그대로 커진다. 임계값은
  // 보드가 실제 분포에서 유도할 몫이고(§4 "Calibration"), 여기 박아 넣으면
  // 빌드 + 전원 재설치 없이는 못 고친다.
  h.setIdle(600_000);
  await h.pinger.tick();
  assert.deepEqual(h.sent[3], { type: "heartbeat", idle_ms: 600_000 });
  console.log("✓ 양성 — 채팅 없이도 핑 · 관측값만 싣고 판정은 보드에 맡긴다");
}

// ─── 음성 — 401 은 영구 정지, 403 은 백오프 후 부활 ─────────────────────────
// 403 = 세션 미개설. 수업 전/후의 **정상 상태**라, 여기서 영구 정지하면
// 강사가 세션을 연 뒤에도 그 자리는 영영 보드에 안 뜬다.
{
  const h = harness({ responses: [{ ok: false, status: 401 }] });
  await h.pinger.tick();
  assert.equal(h.isCleared(), true, "401 → 타이머 해제");
  await h.pinger.tick();
  assert.equal(h.sent.length, 1, "정지 후에는 더 보내지 않는다");
  assert.match(h.logs[0], /401/);
  // 호스트가 참조를 놓을 수 있어야 한다 — 안 그러면 새 토큰을 붙여넣어도
  // Studio 를 껐다 켜기 전까지 그 자리는 보드에서 영영 사라진다.
  assert.equal(h.stoppedCalls.length, 1, "401 정지는 호스트에 통보된다");

  const g = harness({ responses: [{ ok: false, status: 403 }] });
  await g.pinger.tick(); // 실패 1회 → 다음 2틱 건너뜀
  assert.equal(g.isCleared(), false, "403 은 정지가 아니다");
  await g.pinger.tick();
  await g.pinger.tick();
  assert.equal(g.sent.length, 1, "백오프 동안은 조용하다");
  await g.pinger.tick();
  assert.equal(g.sent.length, 2, "백오프가 끝나면 스스로 되살아난다 (재시작 불필요)");
  console.log("✓ 음성 — 401 영구정지 · 403 백오프 후 자가 부활");
}

// ─── 음성 — 백오프는 상한이 있다 (영원히 늘어나 사실상 죽지 않는다) ─────────
{
  const h = harness({ responses: Array.from({ length: 20 }, () => ({ ok: false, status: 0 })) });
  let skips = 0;
  for (let i = 0; i < 60; i++) {
    const before = h.sent.length;
    await h.pinger.tick();
    if (h.sent.length === before) skips++;
  }
  assert.ok(skips > 0, "실패하면 실제로 건너뛴다");
  assert.ok(h.sent.length >= 6, `상한(${HEARTBEAT_MAX_BACKOFF_TICKS}틱) 덕에 계속 재시도한다`);
  console.log("✓ 음성 — 백오프 상한이 있어 완전 침묵으로 굳지 않는다");
}

// ─── stop() 은 멱등하고, 정지 후 tick 은 아무것도 하지 않는다 ────────────────
{
  const h = harness();
  h.pinger.stop();
  h.pinger.stop();
  await h.pinger.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.stoppedCalls.length, 1, "onStopped 는 두 번 불리지 않는다");
  console.log("✓ stop() 멱등");
}

// ─── artifactChanged — '바뀌었을 때만' 이 계약이다 ──────────────────────────
{
  const gate = new ArtifactChangeGate();
  const a = gate.next("<html>1</html>");
  assert.ok(a, "첫 저장은 변경이다");
  assert.equal(gate.next("<html>1</html>"), null, "같은 바이트는 이벤트가 아니다");
  const b = gate.next("<html>2</html>");
  assert.ok(b);
  assert.notEqual(a.sha256, b.sha256);
  assert.equal(gate.next("<html>1</html>") === null, false, "되돌아간 것도 변경이다");

  // 내용은 어디에도 실리지 않는다 — §4 프라이버시가 이 보드를 배포 가능하게 한다.
  const SECRET = "우리 반 친구 이름은 지민이야";
  const ev = buildArtifactChangedEvent(`<html>${SECRET}</html>`);
  assert.deepEqual(Object.keys(ev).sort(), ["bytes", "sha256", "type"]);
  assert.ok(!JSON.stringify(ev).includes("지민"), "내용이 페이로드에 없다");
  assert.equal(ev.bytes, Buffer.byteLength(`<html>${SECRET}</html>`, "utf8"), "바이트 = UTF-8 길이");
  assert.match(ev.sha256, /^[0-9a-f]{64}$/);
  console.log("✓ artifactChanged — 변경일 때만 · 다이제스트+길이만");
}

// ─── idle_ms 방어 — 시계 역행/NaN 이 음수 페이로드가 되지 않는다 ─────────────
{
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const ev = buildHeartbeatEvent(bad);
    assert.equal(ev.idle_ms, 0, `${bad} → 0`);
    assert.deepEqual(Object.keys(ev).sort(), ["idle_ms", "type"], "판정 필드는 없다");
  }
  assert.equal(buildHeartbeatEvent(1234.6).idle_ms, 1235, "정수로 반올림 (워커는 정수만 기대하지 않지만 KV 값은 깨끗하게)");
  console.log("✓ idle_ms — 시계 역행/NaN 방어 · 관측값 단 하나");
}

console.log("heartbeat.smoke.mjs — all green");
