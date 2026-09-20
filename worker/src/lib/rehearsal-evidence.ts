// 리허설 증거 — 쓰는 쪽 (#1186, RUN-01·VER-02).
//
// 상태: **Router 결정 (2026-09-21) · JY 검토 전.** 확정 계약이 아니다.
// 근거가 더 나오면 뒤집는다. 뒤집으면 여기 주석도 같이 뒤집는다.
//
// WHY 이 모듈이 있나
//   읽는 쪽(#1152, `routes/authoring.ts` 의 `readRehearsal`)은 있는데
//   `authoring_version_rehearsals` 에 **행을 쓰는 경로가 없었다.** 그래서 강사가 리허설을
//   돌려도 응답은 **항상 `not_run`** 이었다. 2026-09-20 에 이 사슬이 도는 것을 증명할 때
//   증거를 D1 에 **직접 넣어서** 확인했다 — 제품 경로가 아니었다. 이 모듈이 그 빠진 칸이다.
//
// 🔴 강사가 「통과」를 자칭할 수 없는 이유는 권한 검사가 아니다 — **받을 자리가 없어서다**
//   이 모듈에도, 이 모듈을 부르는 경로에도 `status` 를 **입력으로 받는 자리가 없다.**
//   판정은 Service 가 **자기가 기록한 것**(`usage_log`, `lib/analytics.ts` persistUsage)에서만
//   도출한다. 막는 것보다 만들지 않는 것이 강하다(`ARC-01`).
//   **이 성질을 깨뜨리지 마라.** 판정을 인자로 받는 순간 이 이슈 전체가 무의미해진다.
//   Studio 가 올리는 진행 신호도 받지 않는다 — 그것도 강사가 조작할 수 있는 자리다.
//
// ⚠️ 이것이 증명하지 않는 것 — 반드시 같이 읽어라
//   `passed` 는 **"그 좌표로 리허설 좌석이 실제로 돌았고 오류 턴이 없었다"** 까지만 말한다.
//   **「수업 내용이 좋았나」는 이 모듈이 답할 수 없다.** 단계를 끝까지 밟았는지도 모른다 —
//   단계 이행을 Service 에 알리는 경로가 오늘 없고(`lib/session-design.ts` 의 `steps[]` 에는
//   `acceptance` 가 **문구로만** 있다), 그것을 Studio 가 보고하게 만들면 위의 자칭 경로가
//   다시 열린다.
//   기준을 올리려면 `MIN_PASSING_TURNS` 를 올리지 마라. **`evidence_json` 에 이미 쌓아 둔
//   관측 사실로 새 판정을 짜라** — 그래서 아래가 임계값 하나가 아니라 관측 전부를 담는다.
//   화면은 이 한계보다 더 말하면 안 된다. 그게 #1012 에서 고치던 바로 그 병이다.

import type { Env } from '../env';

/**
 * 관측된 사실. **전부 `usage_log` 집계에서 나온다** — 클라이언트가 채우는 필드는 하나도 없다.
 * 이 타입에 클라이언트가 보낸 값을 담을 자리를 만들지 마라.
 */
export interface RehearsalObservation {
  /** 이 좌석이 돌린 턴 수 (성공·실패 전부). */
  turns: number;
  /** 그중 오류로 끝난 턴 수. `usage_log.status >= 400` — #684 이후 실패도 실제 상태로 남는다. */
  error_turns: number;
  /** 처음/마지막 턴 시각. 행이 하나도 없으면 null. */
  first_at: string | null;
  last_at: string | null;
}

/**
 * `passed` 에 필요한 **오류 없는 턴**의 최소 개수.
 *
 * 오늘 1 인 이유: Service 가 관측할 수 있는 것이 「좌표가 맞는 리허설 좌석이 실제로 돌았다」
 * 까지이고, 2 든 10 이든 **그보다 더 많은 것을 증명하지 않으면서** 짧고 정직한 리허설만
 * 떨어뜨린다. 숫자를 올리는 것은 엄격해 보일 뿐 아는 것을 늘리지 않는다.
 * 올리기 전에 위 「증명하지 않는 것」을 읽어라 — 올려야 할 것은 대개 이 숫자가 아니다.
 */
export const MIN_PASSING_TURNS = 1;

/**
 * 관측 → 판정. **순수 함수다.** 앱도 D1 도 없이 대조군을 돌릴 수 있어야 하기 때문이다
 * (`.claude/rules/verification.md` 규칙 2 — 양성/음성 대조군).
 *
 * `null` 은 **행을 쓰지 않는다**는 뜻이고, 행이 없는 것이 곧 `not_run` 이다.
 * `'not_run'` 을 반환하지 않는 것은 빠뜨린 게 아니라 스키마가 그렇게 말하기 때문이다 —
 * `CHECK (status <> 'not_run')`: **부재가 그 상태의 유일한 모양이다.**
 *
 * 중간에 그만둔 리허설이 `failed` 가 아니라 여기로 떨어진다(Router 결정 2, 2026-09-21):
 * 뒤에 걸릴 관문에서 `not_run` 과 `failed` 는 **똑같이 막힌다.** `failed` 로 적으면 안전은
 * 한 톨도 안 늘고 **「깨지는 걸 봤다」와 「끝을 못 봤다」가 한 글자가 된다.**
 */
export function deriveRehearsalStatus(o: RehearsalObservation): 'passed' | 'failed' | null {
  if (o.error_turns > 0) return 'failed';
  return o.turns - o.error_turns >= MIN_PASSING_TURNS ? 'passed' : null;
}

/** 증거 한 행이 매달릴 좌표와, 그것을 관측할 좌석. */
export interface RehearsalCoordinates {
  /**
   * 확정 버전이 사는 코호트. `readRehearsal()` 이 묻는 것과 **같은 값**이어야 한다
   * (= `profileServesCohort` 의 `lessonCohort`, `readLesson` 이 조회하는 코호트).
   */
  cohort: string;
  course: string;
  version: string;
  /**
   * 리허설 좌석 id. 교환권 하나가 좌석 하나를 내므로(`lib/rehearsal-ticket.ts` `rehearsalSeat`,
   * 매번 새 난수 접미사) **좌석 하나 = 리허설 한 판**이다. 그래서 이 값이 「판」의 식별자다.
   */
  seat: string;
  /**
   * `usage_log` 행이 실린 코호트(토큰의 `c`). 리허설 좌석에서는 `cohort` 와 같은 값이지만
   * **같다고 가정하지 않고 따로 받는다** — 둘은 다른 질문이고, 한 변수로 합치면 수업 개설
   * (IC-B, 템플릿 코호트)에서 조용히 갈린다.
   */
  seatCohort: string;
}

/**
 * 이 좌석이 지금까지 돌린 것을 센다. **Service 가 자기가 쓴 행만 읽는다.**
 * 좌석 id 는 교환권마다 새로 나므로 이 집계의 범위가 곧 한 판의 범위다.
 */
export async function observeRehearsal(env: Env, c: RehearsalCoordinates): Promise<RehearsalObservation> {
  const row = await env.HPS_DB.prepare(
    `SELECT COUNT(*) AS turns,
            SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS error_turns,
            MIN(created_at) AS first_at,
            MAX(created_at) AS last_at
       FROM usage_log WHERE cohort_id=? AND user_id=?`,
  ).bind(c.seatCohort, c.seat).first<{ turns: number; error_turns: number | null; first_at: string | null; last_at: string | null }>();
  return {
    turns: row?.turns ?? 0,
    // 행이 하나도 없으면 SUM 은 NULL 이다. 0 으로 읽어야 하고, **NULL 을 오류 없음으로
    // 읽는 것이 맞다** — 턴이 없으면 오류 턴도 없다(그리고 turns 가 0 이라 판정도 null 이다).
    error_turns: row?.error_turns ?? 0,
    first_at: row?.first_at ?? null,
    last_at: row?.last_at ?? null,
  };
}

/** `evidence_json` 에 담기는 모양. 판정을 다시 짤 사람이 스키마를 안 고치고 쓸 수 있어야 한다. */
export function rehearsalEvidence(c: RehearsalCoordinates, o: RehearsalObservation) {
  return {
    /** 한 판의 식별자 = 좌석. 같은 판의 실패를 나중 성공이 덮지 못하게 하는 데도 쓰인다. */
    run: c.seat,
    turns: o.turns,
    error_turns: o.error_turns,
    first_at: o.first_at,
    last_at: o.last_at,
    /** 판정 당시의 임계값. 나중에 바뀌어도 옛 행이 무엇으로 판정됐는지 남는다. */
    min_passing_turns: MIN_PASSING_TURNS,
    /** 무엇을 보고 판정했는지. 클라이언트 보고가 아니라는 것을 행 자체가 말한다. */
    source: 'usage_log',
  };
}

/**
 * 관측 → 판정 → 증거 한 행. 리허설 좌석에서만 부른다.
 *
 * **실제 학생 트래픽은 증거를 만들지 않는다.** 호출부가 `payload.rehearsal === true` 일 때만
 * 부르고, 그 판정은 문자열 접두사가 아니라 **토큰 클레임**으로 한다(`lib/rehearsal-ticket.ts`
 * 의 주석: 접두사는 사람이 읽는 표시이지 권한이 아니다).
 *
 * 돌려주는 값은 **쓴 결과**이지 입력이 아니다 — 시험이 읽으라고 있는 것이다.
 */
export async function recordRehearsalEvidence(env: Env, c: RehearsalCoordinates): Promise<'passed' | 'failed' | null> {
  const observation = await observeRehearsal(env, c);
  const status = deriveRehearsalStatus(observation);
  // 판정이 서지 않으면 **아무것도 쓰지 않는다.** 그것이 `not_run` 이다.
  if (!status) return null;
  const evidence = rehearsalEvidence(c, observation);
  // 같은 버전을 여러 번 리허설하면 **마지막 판이 진실**이다(Router 결정 5, 2026-09-21).
  // 「하나라도 통과면 통과」는 강사가 **통과할 때까지 돌린 뒤 초록을 박제**하게 만든다.
  // 버전은 불변이지만 **환경(모델·업스트림)은 변하고, 리허설이 재는 게 바로 그 환경**이다
  // (`RUN-01` = 학생 조건). `VER-02`/`T-07` 의 "이전 합격 기록 유지" 가 가리키는 것은
  // **다른 버전의 행**이지 같은 버전의 옛 판이 아니다.
  //
  // WHERE 절은 **한 판 안에서만** 덮어쓰기를 막는다: 같은 판(`$.run` 일치)의 `failed` 를
  // `passed` 가 덮지 못한다. 집계는 매번 좌석 전체를 다시 세므로 오류 수가 줄어들 수는
  // 없지만, 동시 턴이면 **옛 집계가 나중에 착지**할 수 있다. 그러면 초록이 잘못 뜬다 —
  // `.claude/rules/verification.md` 규칙 6 이 말하는 **못 잡는 방향**이다. 그래서 순서와
  // 무관하게 닫히게 만든다. 다른 판(`$.run` 불일치)은 위의 last-write-wins 대로 덮는다.
  await env.HPS_DB.prepare(
    `INSERT INTO authoring_version_rehearsals (cohort_id,course_id,version,status,ran_at,evidence_json)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(cohort_id,course_id,version) DO UPDATE SET
       status=excluded.status, ran_at=excluded.ran_at, evidence_json=excluded.evidence_json
     WHERE NOT (authoring_version_rehearsals.status='failed'
            AND excluded.status<>'failed'
            AND json_extract(authoring_version_rehearsals.evidence_json,'$.run')
              = json_extract(excluded.evidence_json,'$.run'))`,
  ).bind(c.cohort, c.course, c.version, status, observation.last_at ?? new Date().toISOString(), JSON.stringify(evidence)).run();
  return status;
}

/**
 * 라우트가 부르는 자리. **한 턴이 `usage_log` 에 앉은 뒤에** 부른다.
 *
 * 여기가 「리허설인가」를 판정하는 **유일한 곳**이다. 두 라우트가 각자 판정하면 갈린다 —
 * 이 저장소가 세어 둔 실패가 정확히 그 형태다(`lib/rehearsal-ticket.ts` 주석).
 * 판정은 **토큰 클레임**으로 한다. 좌석 id 의 `rehearsal-` 접두사는 사람이 읽는 표시이지
 * 권한이 아니다.
 *
 * 증거 쓰기가 실패해도 **학생의 턴은 건드리지 않는다.** 증거를 못 남기는 것이 대화를 끊는
 * 것보다 낫고, 그때 응답은 `not_run` 이 된다 — 그것은 오보가 아니라 사실이다(증거가 실제로
 * 없다). 읽는 쪽이 테이블 부재를 `not_run` 으로 떨어뜨리는 것과 같은 방향이다.
 */
export async function recordRehearsalTurn(
  env: Env,
  payload: { rehearsal?: true; u: string; c: string },
  lesson: { cohort: string; course_id: string; version: string } | null,
): Promise<'passed' | 'failed' | null> {
  // 🔴 리허설 좌석이 아니면 아무것도 쓰지 않는다. **실제 학생 트래픽은 증거가 되지 않는다.**
  if (payload.rehearsal !== true || !lesson) return null;
  try {
    return await recordRehearsalEvidence(env, {
      cohort: lesson.cohort,
      course: lesson.course_id,
      version: lesson.version,
      seat: payload.u,
      seatCohort: payload.c,
    });
  } catch (err) {
    console.error('rehearsal evidence write failed (turn served; version stays not_run):', err);
    return null;
  }
}
