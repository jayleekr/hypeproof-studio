// #642 — 코치가 일하는 동안 살아있는 화면: 달리는 게스트.
//
// 실기기(2026-08-20, Windows): 코치가 "Read ✓" 를 찍은 뒤 1~3분 동안 화면이
// 통째로 정적이다. 초3·4 는 그 정적을 **고장**으로 읽어 사이드바를 다시 누르거나
// 같은 말을 또 보냈고(턴이 겹친다), 옆에 있던 어른도 "멈춘 것 같다" 고 말했다.
// 툴 로그의 "✍️ 고치는 중…" 한 줄로는 부족하다 — 글자는 서 있고, 아이는 움직이는
// 것만 살아있다고 본다.
//
// 결정한 것: 지금 열린 세상의 게스트 이모지가 작성란 위 트랙을 달린다. 여기에는
// **판단만** 산다(언제 보이나 · 지금 무슨 문구인가 · 누구 얼굴인가). React 도 DOM 도
// 모르는 순수 모듈이라 ChatPanel.tsx 와 test/runner-bar.smoke.mjs 가 같은 것을 쓴다.
// 애니메이션 자체는 CSS(styles.css .hps-runner-*) 가 가진다.

/** 문구가 바뀌는 주기. 4초 — 읽고 눈을 뗄 만큼 길고, 죽은 화면으로 보이지 않을 만큼 짧다. */
export const RUNNER_PHRASE_MS = 4000;

/** 세상 하나 — protocol 의 worlds[] 중 러너가 쓰는 부분만(구조적 부분집합). */
export interface RunnerWorld {
  id: string;
  guest?: string;
  emoji?: string;
}

/** 러너가 쓸 얼굴. guest 가 null 이면 이름을 부르는 문구는 빠진다. */
export interface RunnerFace {
  emoji: string;
  guest: string | null;
}

/** 세상을 못 찾았을 때의 얼굴. 빈칸을 두면 트랙만 덩그러니 남는다. */
const RUNNER_FALLBACK_EMOJI = "✨";

/**
 * 러너가 어느 코호트에서 도는가 — 프로필에 세상이 실려 오거나(kids-quest) 톤이
 * quest 인 화면. 성인 트랙(웹사이트·검색엔진)은 기다림의 의미가 다르고, 진행
 * 표시가 이미 툴 로그로 충분하다.
 */
export function isRunnerCohort(args: { worldCount: number; tone: string }): boolean {
  return args.worldCount > 0 || args.tone === "quest";
}

/** 지금 러너가 달려야 하는가. 턴이 끝나면 즉시 false — 끝난 뒤에도 달리면 거짓말이 된다. */
export function shouldShowRunner(args: {
  streaming: boolean;
  worldCount: number;
  tone: string;
}): boolean {
  return args.streaming && isRunnerCohort(args);
}

/**
 * 지금 열린 세상의 얼굴. 아직 아무 세상도 안 열렸거나(첫 턴) 프로필에 없는 id 면
 * ✨ 로 달린다 — 남의 세상 이모지를 빌려 오는 것보다 낫다.
 */
export function runnerFace(
  worlds: readonly RunnerWorld[] | null | undefined,
  openWorldId: string | null | undefined,
): RunnerFace {
  const list = worlds ?? [];
  const found = openWorldId ? list.find((w) => w.id === openWorldId) : undefined;
  const emoji = (found?.emoji ?? "").trim();
  const guest = (found?.guest ?? "").trim();
  return { emoji: emoji || RUNNER_FALLBACK_EMOJI, guest: guest || null };
}

/**
 * 순환 문구. '게임' 이라는 낱말은 쓰지 않는다 — 이건 '세상' 이다.
 * 게스트 이름을 알 때만 마지막 한 줄("○○가 지켜보고 있어요")이 붙는다: 이름을
 * 모르면 "가 지켜보고 있어요" 같은 조각이 뜨는 것보다 세 줄로 도는 편이 낫다.
 */
export function runnerLines(guest: string | null | undefined): string[] {
  const name = (guest ?? "").trim();
  const base = ["세상을 고치는 중…", "조금만 기다려요…", "거의 다 됐어요…"];
  return name ? [...base, `${name}${subjectParticle(name)} 지켜보고 있어요`] : base;
}

/**
 * 주격 조사 — 받침이 있으면 '이', 없으면 '가'.
 *
 * 2026-08-20 검토: 늘 "가" 로 붙였더니 아홉 친구 중 셋(붕붕·찍찍·라쿤)에서
 * "붕붕가 지켜보고 있어요" 같은 비문이 떴다. 초3·4 가 한 턴에 1~3분 동안 4초마다
 * 반복해서 읽는 문구다 — 여기서 어긋난 한국어는 눈에 크게 띈다.
 * 한글 음절(가~힣) 밖의 이름(영문·이모지)은 판정할 근거가 없어 "가" 로 둔다.
 */
function subjectParticle(name: string): string {
  const code = name.charCodeAt(name.length - 1);
  if (!Number.isFinite(code) || code < 0xac00 || code > 0xd7a3) return "가";
  return (code - 0xac00) % 28 ? "이" : "가";
}

/**
 * 경과 시간(ms) → 지금 보여줄 문구의 인덱스. 4초마다 다음 줄, 끝나면 처음으로.
 * 음수/NaN 경과(시계 되감김, 첫 렌더)와 빈 목록에서도 항상 유효한 인덱스를 준다 —
 * 여기서 undefined 가 새면 화면에 빈 줄이 뜬다.
 */
export function runnerPhraseIndex(elapsedMs: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.floor(elapsedMs / RUNNER_PHRASE_MS) % count;
}

/** 경과 시간 + 게스트 → 지금 띄울 한 줄. 컴포넌트가 인덱스 계산을 다시 하지 않게. */
export function runnerPhrase(elapsedMs: number, guest: string | null | undefined): string {
  const lines = runnerLines(guest);
  return lines[runnerPhraseIndex(elapsedMs, lines.length)] as string;
}
