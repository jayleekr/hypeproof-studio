#!/usr/bin/env bash
# Chalk tool flow pre-flight check for review-pr.sh --after.
# Runs: chalk_set_inputs → chalk_recommend_methods → chalk_generator_brief
#       → chalk_save_plan → chalk_open_course
# Called by review-pr.sh with:
#   REVIEW_SERVER_URL  e.g. http://127.0.0.1:8787
#   REVIEW_COHORT      cohort id
#   REVIEW_COURSE      course id (draft already created by review-pr.sh)
#   REVIEW_ISSUER_TOKEN_FILE  path to token file (never the value)
# Token value is read from the file here; never printed.
set -Eeuo pipefail

: "${REVIEW_SERVER_URL:?REVIEW_SERVER_URL required}"
: "${REVIEW_COHORT:?REVIEW_COHORT required}"
: "${REVIEW_COURSE:?REVIEW_COURSE required}"
: "${REVIEW_ISSUER_TOKEN_FILE:?REVIEW_ISSUER_TOKEN_FILE required}"

if [[ ! -f "$REVIEW_ISSUER_TOKEN_FILE" ]]; then
  echo "ERROR: token file not found: $REVIEW_ISSUER_TOKEN_FILE" >&2
  exit 1
fi

FLOW_TOKEN="$(cat "$REVIEW_ISSUER_TOKEN_FILE")"
FLOW_PORT="${REVIEW_SERVER_URL##*:}"

WORKTREE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
EXEC_SCRIPT="$(mktemp /tmp/chalk-flow-exec-XXXXXX.mjs)"
FLOW_CWD="$(mktemp -d /tmp/chalk-flow-cwd-XXXXXX)"
trap 'rm -f "$EXEC_SCRIPT"; rm -rf "$FLOW_CWD"' EXIT

cat > "$EXEC_SCRIPT" << 'MSCRIPT'
import { execSetInputs, execRecommendMethods, execGeneratorBrief, execOpenCourse, execSavePlan } from '/WORKTREE/extensions/hypeproof-chat/src/chalk/tools.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const TOKEN   = process.env.FLOW_TOKEN;
const PORT    = process.env.FLOW_PORT ?? '8787';
const COHORT  = process.env.FLOW_COHORT;
const COURSE  = process.env.FLOW_COURSE;
const CWD     = process.env.FLOW_CWD;

if (!TOKEN || !COHORT || !COURSE || !CWD) {
  console.error('FLOW_TOKEN / FLOW_COHORT / FLOW_COURSE / FLOW_CWD required');
  process.exit(1);
}

const secrets = { get: async () => TOKEN, store: async () => {}, delete: async () => {}, keys: async () => [] };
const ctx = {
  serverUrl: `http://127.0.0.1:${PORT}`,
  secrets,
  cwd: CWD,
  requestConfirmation: async () => true,
};

let allOk = true;
async function step(name, fn) {
  process.stdout.write(`[STEP] ${name} ... `);
  try {
    const r = await fn();
    console.log('OK');
    if (r !== undefined) {
      const s = JSON.stringify(r, null, 2);
      console.log(s.length > 600 ? s.slice(0, 600) + '\n  ...(truncated)' : s);
    }
    return r;
  } catch (e) {
    console.log(`FAIL: ${e.message}`);
    allOk = false;
    return null;
  }
}

await step('chalk_set_inputs', () =>
  execSetInputs(ctx, {
    cohort: COHORT, course: COURSE,
    audience: 'SK바이오팜 신입 연구원 30명, 이공계 배경, AI 협업 경험 없음',
    assets: ['INTENT', 'VERIFY', 'ITERATE'],
    teaching_style: '탐구 학습 + 팀 토론',
    requirements: '실제 연구 시나리오 활용, 120분 이내',
    format: 'workshop', family_session: false,
    vocab: {
      goals: ['conceptual-understanding', 'acquire-procedure'],
      conditions: ['large-group', 'short-session'],
    },
  })
);

await step('chalk_recommend_methods', () =>
  execRecommendMethods(ctx, {
    cohort: COHORT, course: COURSE,
    conditions: ['large-group', 'short-session'],
    goals: ['acquire-procedure', 'conceptual-understanding'],
    knowledge_version: 1,
  })
);

await step('chalk_generator_brief', () =>
  execGeneratorBrief(ctx, { cohort: COHORT, course: COURSE })
);

const planFile = join(CWD, 'chalk', COURSE, 'lesson.html');
await step('로컬 lesson.html 생성', async () => {
  await mkdir(dirname(planFile), { recursive: true });
  await writeFile(planFile, '<h1>Review 사전 확인</h1><p>review-pr.sh --after flow check</p>', 'utf8');
  return { path: planFile };
});

await step('chalk_save_plan', () =>
  execSavePlan(ctx, { cohort: COHORT, course: COURSE, file: 'lesson', knowledge_version: 1 })
);

await step('chalk_open_course (save_plan 이후)', async () => {
  const r = await execOpenCourse(ctx, { cohort: COHORT, course: COURSE, file: 'lesson' });
  if (!r || !('localPath' in r)) throw new Error(`localPath missing: ${JSON.stringify(Object.keys(r ?? {}))}`);
  return { localPath: r.localPath };
});

if (allOk) { console.log('\n✅ flow check 완료.'); }
else { console.log('\n⚠️ 일부 단계 실패 — 위 FAIL 확인.'); process.exit(1); }
MSCRIPT

# Inject actual WORKTREE path (macOS BSD sed requires empty string for -i)
sed -i '' "s|/WORKTREE/|${WORKTREE_DIR}/|g" "$EXEC_SCRIPT"

echo ""
echo "=== [chalk flow check] set_inputs → recommend → brief → save_plan → open_course ==="
echo "  cohort=${REVIEW_COHORT}  course=${REVIEW_COURSE}"

FLOW_TOKEN="$FLOW_TOKEN" \
FLOW_PORT="$FLOW_PORT" \
FLOW_COHORT="$REVIEW_COHORT" \
FLOW_COURSE="$REVIEW_COURSE" \
FLOW_CWD="$FLOW_CWD" \
  node --experimental-strip-types "$EXEC_SCRIPT" 2>&1

echo "=== [chalk flow check] done ==="
