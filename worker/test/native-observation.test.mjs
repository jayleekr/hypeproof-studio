import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  OBSERVATION_FORMAT,
  OBSERVATION_ASSETS,
  validateObservation,
  validateFindings,
} from "../src/lib/native-observation.ts";
const e = (id, seq, kind = "user", extra = {}) => ({
  id,
  seq,
  task: "task-1",
  at: seq,
  text: "새 직원이 주문을 확인할 문서가 필요해",
  kind,
  assistance: "unknown",
  ...extra,
});
const b = (events) => ({
  format: OBSERVATION_FORMAT,
  scope: "synthetic-seat",
  session: "s1",
  program: "m2026.09.08-1",
  events,
});
const findings = () =>
  OBSERVATION_ASSETS.map((asset) => ({
    asset,
    status: "unobserved",
    interpretation: "근거 부족",
    evidence: [],
    assistance: "unknown",
    next: "다음 작업에서 확인",
  }));
test("App and Service exact drift lock", () =>
  assert.equal(
    readFileSync(
      new URL("../src/lib/native-observation.ts", import.meta.url),
      "utf8",
    ),
    readFileSync(
      new URL(
        "../../extensions/hypeproof-chat/src/nativeObservationContract.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ));
test("separate roles, reorder, idempotent resend, missing sequence", () => {
  const events = [
    e("u1", 1),
    e("c1", 2, "coach"),
    e("t1", 3, "tool_request", { tool_id: "tool-1" }),
    e("a1", 4, "approval", {
      tool_id: "tool-1",
      actor: "policy",
      outcome: "allowed",
    }),
    e("r1", 5, "tool_result", { tool_id: "tool-1", outcome: "success" }),
  ];
  assert.deepEqual(
    validateObservation(b([...events].reverse().concat(events[0]))).batch
      .events,
    events,
  );
  assert.deepEqual(validateObservation(b([events[1]])).missing, [1]);
});
test("duplicates with changed payload, sequence collisions, old clients and orphan results fail", () => {
  assert.throws(() => validateObservation(b([e("a", 1), e("a", 1, "coach")])));
  assert.throws(() => validateObservation(b([e("a", 1), e("b", 1)])));
  assert.throws(() =>
    validateObservation({ ...b([]), format: "hps-observation/0" }),
  );
  assert.throws(() =>
    validateObservation(
      b([e("r", 1, "tool_result", { tool_id: "absent", outcome: "success" })]),
    ),
  );
});
test("known human statement has verifiable citation; missing assets stay unobserved", () => {
  const f = findings();
  f[1] = {
    ...f[1],
    status: "observed",
    interpretation: "대상과 목적을 제시했다",
    evidence: [{ event_id: "u1", quote: "새 직원" }],
  };
  assert.equal(validateFindings(f, b([e("u1", 1)]))[1].status, "observed");
  assert.equal(f.filter((v) => v.status === "unobserved").length, 6);
});
test("fake IDs, changed quotes, assistant-only citations, scores and unsupported independence fail", () => {
  for (const ref of [
    { event_id: "missing", quote: "새 직원" },
    { event_id: "u1", quote: "지어낸 인용" },
    { event_id: "c1", quote: "새 직원" },
  ]) {
    const f = findings();
    f[1] = { ...f[1], status: "observed", evidence: [ref] };
    assert.throws(() =>
      validateFindings(f, b([e("u1", 1), e("c1", 2, "coach")])),
    );
  }
  const f = findings();
  f[0].score = 100;
  assert.throws(() => validateFindings(f, b([])));
  const g = findings();
  g[1] = {
    ...g[1],
    status: "observed",
    assistance: "independent",
    evidence: [{ event_id: "u1", quote: "새 직원" }],
  };
  assert.throws(() => validateFindings(g, b([e("u1", 1)])));
});

test("model selects immutable source excerpts; unknown selectors and authored quotes fail", async () => {
  const { makeEvidenceCatalog, resolveEvidenceSelections } = await import(
    "../src/lib/native-evidence.ts"
  );
  const batch = b([e("u1", 1)]),
    catalog = makeEvidenceCatalog(batch),
    f = findings();
  f[1] = { ...f[1], status: "observed", evidence: [{ quote_id: "q0" }] };
  assert.deepEqual(
    validateFindings(
      resolveEvidenceSelections(
        f.map((v) =>
          v.status === "unobserved"
            ? {
                asset: v.asset,
                status: v.status,
                interpretation: v.interpretation,
                next: v.next,
              }
            : v,
        ),
        catalog,
      ),
      batch,
    )[1].evidence,
    [{ event_id: "u1", quote: batch.events[0].text }],
  );
  for (const ref of [
    { quote_id: "q999" },
    { quote_id: "q0", quote: "invented" },
    { event_id: "u1", quote: "invented" },
  ]) {
    f[1].evidence = [ref];
    assert.throws(
      () =>
        resolveEvidenceSelections(
          f.map((v) =>
            v.status === "unobserved"
              ? {
                  asset: v.asset,
                  status: v.status,
                  interpretation: v.interpretation,
                  next: v.next,
                }
              : v,
          ),
          catalog,
        ),
      /invalid_quote_selection/,
    );
  }
});

test('self report cannot replace executed verification or version changes',()=>{
 const f=findings();f[3]={...f[3],status:'observed',evidence:[{event_id:'u1',quote:'새 직원'}]};
 assert.throws(()=>validateFindings(f,b([e('u1',1)])),/missing_execution_evidence/);
 assert.throws(()=>validateObservation(b([e('u1',1,'user',{secret:'must not pass through'})])),/invalid_event/);
 assert.equal(validateObservation({...b([]),incomplete:true}).batch.incomplete,true);
});

test('credential redaction covers reviewed excerpts before any provider request',async()=>{
 const {scrubSecrets}=await import('../src/lib/scrub-secrets.ts');
 const key='sk-ant-'+ 'A'.repeat(28), token='eyJ'+'B'.repeat(30)+'.'+'C'.repeat(30);
 const raw=`업무 설명 ${key} ${token} 안전한 문장`;
 const scrubbed=scrubSecrets(raw);assert.ok(!scrubbed.includes(key));assert.ok(!scrubbed.includes(token));assert.match(scrubbed,/안전한 문장/);
});

test('known assistance provenance is retained without turning it into a score',()=>{
 for(const assistance of ['assisted','independent']){
  const f=findings();f[1]={...f[1],status:'observed',assistance,evidence:[{event_id:'u1',quote:'새 직원'}]};
  const result=validateFindings(f,b([e('u1',1,'user',{assistance})]));assert.equal(result[1].assistance,assistance);assert.equal('score' in result[1],false);
 }
});
