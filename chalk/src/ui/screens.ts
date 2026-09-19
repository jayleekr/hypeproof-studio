// 강사 홈과 "아직 없는 자리" 화면 — 한 표에서 만든다 (#1145 A-1·A-4).
//
// 왜 HTML 파일이 아니라 여기서 그리나:
//   홈은 **화면 목록 자체**를 보여준다. 같은 목록으로 빈 자리 화면도 만든다.
//   두 곳에 나눠 적으면 한쪽만 고쳐지는 날이 오고, 그때 홈은 "있다"고 하는데
//   화면은 "개발 필요"라고 말한다. **상태가 실제와 다르게 보이는 것**이 이 이슈가
//   막으려는 사고라, 목록을 두 벌 두지 않는다.
//
// 경계 (docs/requirements/chalk-authoring.md ARC-01):
//   여기서 만드는 것은 **화면뿐**이다. 상태를 읽지도 쓰지도 않고 자격증명을
//   요구하지도 않는다. 저장·권한·토큰 서명은 Service 의 것이다.

export type ScreenState =
  | { kind: "ready"; path: string }        // 실제로 동작하는 화면
  | { kind: "student"; path: string }      // 학생 화면 — 강사는 확인용으로만 연다
  | { kind: "external"; href?: string }    // 다른 제품에 있다 (주소를 모르면 href 없이 사실만 적는다)
  | { kind: "soon"; path: string };        // 자리만 있고 내용이 없다

export interface Screen {
  title: string;
  desc: string;
  state: ScreenState;
  /** 이 자리가 채우려는 요구사항 ID (docs/requirements/chalk-authoring.md). */
  requirements?: string[];
  /** **내용을 계속 여는 이슈.** 빈 자리를 만든 것이 이 이슈를 닫지 않는다. */
  issues?: number[];
  /** 빈 자리 화면에 적는, 지금 무엇이 없는지에 대한 한 문단. */
  missing?: string;
}

/** 강사가 지금 쓸 수 있는 화면. */
export const READY: Screen[] = [
  { title: "세션 콘솔", desc: "수업 열기·닫기, 학생 참여 코드 일괄 발급, 학생 현황.", state: { kind: "ready", path: "/console" } },
  { title: "수업 작성", desc: "초안을 쓰고 확정 버전을 고정한 뒤 참여 코드를 발급한다.", state: { kind: "ready", path: "/authoring" } },
  { title: "강사 관리", desc: "학생 현황과 공유된 질문·결과물을 열고 피드백을 남긴다.", state: { kind: "ready", path: "/manage" } },
  { title: "라이브 보드", desc: "수업 중 좌석 상태. 10초마다 갱신되는 읽기 전용 화면.", state: { kind: "ready", path: "/board" } },
  { title: "토큰 발급", desc: "본인 코호트의 학생 토큰을 직접 발급한다.", state: { kind: "ready", path: "/issuer" } },
  { title: "수업 AI 예산", desc: "학생별 사용 상한과 마무리 여유를 조절한다.", state: { kind: "ready", path: "/budgets" } },
  { title: "첫 강의 준비하기", desc: "처음이라면 여기부터. 안내만 있고 저장하는 것은 없다.", state: { kind: "ready", path: "/start" } },
];

/** 학생이 쓰는 화면. 강사는 "학생이 무엇을 보나" 확인하려고 연다. */
export const STUDENT: Screen[] = [
  {
    title: "내 수업",
    desc: "학생이 참여 코드로 확정된 과제와 확인 기준을 여는 화면.",
    state: { kind: "student", path: "/student/learn" },
  },
  {
    title: "강사에게 공유",
    desc: "학생이 질문·결과물을 강사에게 보내는 화면. 제목의 '강사에게'는 받는 사람이지 쓰는 사람이 아니다 — 강사가 받은 것을 보는 곳은 「강사 관리」다.",
    state: { kind: "student", path: "/student/sharing" },
  },
];

/** 아직 없는 것. 자리만 만든다. */
export const SOON: Screen[] = [
  {
    title: "준비 점검",
    desc: "수업 전에 실행·자료·도구·인증이 준비됐는지와 남은 할 일을 한 화면에서 본다.",
    state: { kind: "soon", path: "/readiness" },
    requirements: ["RUN-02", "RUN-04"],
    issues: [1012],
    missing:
      "지금은 준비 상태를 한곳에서 볼 자리가 없다. 강사는 콘솔·보드·저작 화면을 오가며 " +
      "각각 다르게 보이는 상태를 머릿속에서 맞춰야 한다. 학생 기기가 수업을 감당하는지 확인하는 " +
      "경로(RUN-04)는 어디에도 없다.",
  },
  {
    title: "리허설",
    desc: "강사 전용 권한 없이 학생과 같은 조건으로 수업을 한 번 돌려 보고, 그 증거를 확정 버전에 묶는다.",
    state: { kind: "soon", path: "/rehearsal" },
    requirements: ["RUN-01", "VER-02"],
    issues: [1012, 1131],
    missing:
      "수업 작성 화면이 확정 뒤에 '리허설 미실행'이라고 적지만 그것은 계산된 값이 아니라 " +
      "항상 그렇게 찍히는 글자다. 리허설을 시작하는 자리도, 결과를 보는 자리도 없다. " +
      "요구사항의 순서는 '확정 전에 리허설'인데 지금 구현은 확정이 먼저다. " +
      "리허설을 어디서 돌릴지(Studio 인지 Chalk 인지)는 #1131 에서 아직 결정 중이다.",
  },
  {
    title: "수업 환경",
    desc: "도구 설치와 예제 실행을 함께 확인하고, 검증한 버전을 수업에 고정한다.",
    state: { kind: "soon", path: "/environment" },
    requirements: ["ENV-01", "ENV-02", "ENV-03", "ENV-05", "ENV-06", "ENV-07"],
    issues: [1011, 1017],
    missing:
      "환경 화면이 통째로 없다. 어떤 도구·예제·설정 버전으로 수업하는지가 화면에 없고, " +
      "새 도구를 수업에 넣기 전에 격리해서 시험하는 자리도 없다.",
  },
  {
    title: "요청 처리",
    desc: "강사가 올린 기능 요청의 상태·담당자·다음 조치와, 실제로 해결됐는지 확인.",
    state: { kind: "soon", path: "/requests" },
    requirements: ["REQ-01", "REQ-02", "REQ-03", "REQ-04"],
    issues: [1016],
    missing:
      "수업 작성 화면 안에 요청을 적는 칸은 있지만 올린 뒤를 볼 자리가 없다. " +
      "지금 어디까지 갔는지, 누가 보고 있는지, 언제쯤인지 — 모르면 강사는 다시 물어보는 수밖에 없다.",
  },
  {
    title: "단건 코드 발급",
    desc: "배부 보드를 거치지 않고 학생 한 명에게 참여 코드를 바로 발급한다.",
    state: { kind: "soon", path: "/mint" },
    issues: [1145],
    missing:
      "API 는 있으나 화면이 없다. 발급 위젯 컴포넌트가 lab 저장소에 존재하는데 어디에서도 불러 쓰지 않아 " +
      "강사가 브라우저로 도달할 방법이 없다. «아직 배포 전»이 아니라 만들어 놓고 연결하지 않은 것이며, " +
      "이 저장소의 검사에서 우리가 센 것과 같은 모양이다 — 있는데 아무도 부르지 않는다. " +
      "Chalk 의 «토큰 발급» 화면은 살아 있으니 지금 필요하면 그쪽을 쓴다.",
  },
  {
    title: "내 강사 코드",
    desc: "강사 코드를 어디서 받고 만료되면 어떻게 갱신하는지.",
    state: { kind: "soon", path: "/access" },
    issues: [1145],
    missing:
      "이 자리가 어디에도 없다. 지금은 사람에게 물어서 받고, 만료되면 다시 물어야 한다. " +
      "요구사항에도 대응하는 행이 없어 '아직 정해지지 않은 것'에 가깝다 — " +
      "빠뜨린 화면이 아니라 **아직 결정되지 않은 절차**다.",
  },
];

/** 다른 제품에 있는 것. A 단계에서는 옮기지 않고 사실만 적는다. */
export const ELSEWHERE: Screen[] = [
  {
    title: "배부 보드 — 치과 회차",
    desc:
      "실제 회차에서 쓴 운영 화면. 강사 위젯(수업 시작·종료, 코드 발급)과 학생용 «내 토큰 받기»가 한 화면에 있다. " +
      "로그인 불필요 · 강사 코드를 붙여넣어야 발급 가능.",
    state: { kind: "external", href: "https://hypeproof-ai.xyz/live/boa" },
  },
  {
    title: "배부 보드 — SK 회차",
    desc: "같은 화면. A/B 분반이라 트랙 선택이 붙는다. 로그인 불필요 · 강사 코드를 붙여넣어야 발급 가능.",
    state: { kind: "external", href: "https://hypeproof-ai.xyz/live/sk-biofarm" },
  },
  {
    title: "배부 보드 — 회차 목록",
    desc:
      "⚠️ 회차마다 전용 주소다. 범용 «수업 열기» 화면이 없어서, 새 회차를 열려면 페이지를 하나 더 만들어야 하는 구조로 보인다. " +
      "목록에서 자기 회차를 못 찾았다면 잘못 온 것이 아니라 아직 만들어지지 않은 것이다.",
    state: { kind: "external", href: "https://hypeproof-ai.xyz/live" },
  },
  {
    title: "강사 콘솔 (멤버)",
    desc:
      "성격이 다르다 — 발급 화면이 아니라 학생 진행 모니터링·피드백용이고, 멤버 로그인을 쓰며 강사 코드를 쓰지 않는다. " +
      "2026-09-04 신설 이후 회차가 없어 아직 실사용 기록이 없다.",
    state: { kind: "external", href: "https://hypeproof-ai.xyz/members/instructor" },
  },
];

export const ALL_SOON = SOON;

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ESC[ch] as string);
const issueUrl = (n: number) => `https://github.com/jayleekr/hypeproof-studio/issues/${n}`;

const NAV: Array<[string, string]> = [
  ["/", "홈"],
  ["/console", "세션 콘솔"],
  ["/authoring", "수업 작성"],
  ["/manage", "강사 관리"],
  ["/board", "라이브 보드"],
  ["/issuer", "참여 코드 발급"],
  ["/start", "처음이라면"],
];

/**
 * 기존 화면 일곱에 그대로 붙여 넣는 머리글. **같은 markup 이어야 한다** —
 * chalk/test/instructor-console.test.mjs 가 아홉 중 여덟에서 이 문자열을 찾는다.
 * (authoring.html 만 빠져 있고, 그것도 시험이 이유와 함께 고정한다.)
 */
export const SHELL_HEAD_MARK = '<header class="shell-head">';
export const SHELL_LINK = '<link rel="stylesheet" href="/shell.css">';

function head(title: string, current: string): string {
  const nav = NAV.map(
    ([href, label]) =>
      `<a href="${href}"${href === current ? ' aria-current="page"' : ""}>${esc(label)}</a>`,
  ).join("");
  return `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · HypeProof Chalk</title>
<link rel="stylesheet" href="/shell.css">
<body class="shell-page">
<div class="wrap">
<header class="shell-head">
  <div class="brand"><a href="/">HypeProof Chalk</a> <span>강사·강의 제작자를 위한 화면</span></div>
  <nav class="shell-nav">${nav}</nav>
</header>`;
}

const FOOT = `<footer class="shell-foot">
  Chalk 는 화면과 전달만 맡는다. 저장·권한·토큰 서명은 Service 가 소유한다 (<code>ARC-01</code>).
</footer>
</div>
</body>
</html>`;

function card(s: Screen): string {
  const tag =
    s.state.kind === "ready" ? '<span class="tag ok">쓸 수 있음</span>'
    : s.state.kind === "student" ? '<span class="tag student">학생 화면</span>'
    : s.state.kind === "external" ? '<span class="tag">다른 제품</span>'
    : '<span class="tag soon">개발 필요</span>';
  const inner = `<div class="t">${esc(s.title)} ${tag}</div><div class="d">${esc(s.desc)}</div>`;
  if (s.state.kind === "external") {
    return s.state.href
      ? `<a class="card" href="${s.state.href}" rel="noreferrer">${inner}</a>`
      : `<div class="card">${inner}</div>`;
  }
  const cls = s.state.kind === "soon" ? "card soon" : "card";
  return `<a class="${cls}" href="${s.state.path}">${inner}</a>`;
}

/**
 * 강사 홈 — `/`. 자격증명을 묻지 않고 아무것도 부르지 않는다.
 *
 * 이 화면의 값은 목록이 **정직하다**는 것이다. 쓸 수 있는 것과 아직 못 하는 것이
 * 같은 화면에 있고, 없는 것은 왜 없는지로 이어진다.
 */
export function homePage(): string {
  return `${head("강사 홈", "/")}
<h1>강사 홈</h1>
<p class="lede">여기서 할 수 있는 일 전부입니다. <strong>아직 못 하는 것도 함께 적었습니다.</strong></p>

<h2>지금 쓸 수 있는 화면</h2>
<div class="grid">${READY.map(card).join("")}</div>

<h2>학생이 보는 화면 — 확인용으로 열 수 있습니다</h2>
<div class="grid">${STUDENT.map(card).join("")}</div>

<h2>아직 없는 것</h2>
<p class="lede">자리만 있고 내용이 없습니다. 열어 보면 무엇이 왜 없는지와 어디서 논의 중인지가 적혀 있습니다.</p>
<div class="grid">${SOON.map(card).join("")}</div>

<h2>다른 제품에 있는 것</h2>
<div class="grid">${ELSEWHERE.map(card).join("")}</div>

<div class="note">
  <strong>머리글이 화면마다 다르게 보일 수 있습니다.</strong>
  「수업 작성」은 아직 이 공통 껍데기를 쓰지 않습니다 — 그 화면이 이번 주 시연에 쓰여서
  건드리지 않았습니다. <strong>지금은 두 벌이고, 시연 다음 날 첫 작업으로 합칩니다.</strong>
  같은 이유로 강사 코드를 「수업 작성」·「강사 관리」·「수업 AI 예산」에서 다시 붙여넣어야 할 수 있습니다.
</div>
${FOOT}`;
}

/** 빈 자리 화면 — 레이아웃과 제목, 그리고 **무엇이 왜 없는지**. */
export function placeholderPage(s: Screen): string {
  const path = s.state.kind === "soon" ? s.state.path : "/";
  const reqs = s.requirements?.length
    ? `<dt>채워야 할 요구사항 (<code>docs/requirements/chalk-authoring.md</code>)</dt>
       <dd>${s.requirements.map((r) => `<code>${esc(r)}</code>`).join(" · ")}</dd>`
    : "";
  const issues = s.issues?.length
    ? `<dt>내용을 계속 여는 곳 — <strong>이 화면이 생겼다고 닫히지 않습니다</strong></dt>
       <dd>${s.issues.map((n) => `<a href="${issueUrl(n)}">#${n}</a>`).join(" · ")}</dd>`
    : "";
  return `${head(s.title, path)}
<h1>${esc(s.title)}</h1>
<p class="lede">${esc(s.desc)}</p>
<div class="soon-body">
  <div class="big">개발 필요 — 아직 만들지 않았습니다.</div>
  <p>${esc(s.missing ?? "")}</p>
  <dl>${reqs}${issues}</dl>
</div>
<p class="lede" style="margin-top:18px"><a href="/">← 강사 홈</a></p>
${FOOT}`;
}
