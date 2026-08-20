// 갤러리 발행 — "갤러리에 올리기" 의 네트워크 절반.
//
// 아이가 만든 세상 HTML 한 장을 lab 사이트(`hypeproof-ai.xyz`)의
// `POST /api/gallery/publish` 로 보낸다. 그 라우트가 워커에 토큰을 물어
// 서명·만료·역할·코호트 opt-in 을 확인하고, 배부보드에서 아이 이름을 찾아
// Supabase Storage 에 올린다.
//
// **누구 것인지는 여기서 안 보낸다.** 신원은 Authorization 헤더의 토큰
// payload 에서만 나온다 — 서버가 그렇게 강제한다. 여기서 이름이나 자리번호를
// body 에 실으면 그건 서버가 무시하는 값이거나, 언젠가 누가 그것을 믿게 만드는
// 구멍이다. 둘 다 좋지 않다.
//
// `vscode` 를 import 하지 않는다 — 순수 로직이라 플레인 Node + 주입 fetch 로
// 검증한다 (spoolUploader.ts 와 같은 규율).

/** lab 사이트. 설정으로 덮을 수 있다 — 로컬 dev 서버(:3000)에 붙여 보기 위함. */
export const SITE_BASE_PROD = "https://hypeproof-ai.xyz";

export interface PublishInput {
  siteBase: string;
  /** 학생 워크숍 토큰. 이것이 신원의 유일한 출처다. */
  token: string;
  /** 지금 열려 있는 세상 id (`kq-*`). 서버가 알려진 목록으로 대조한다. */
  worldId: string;
  title: string;
  /** engine.js 까지 인라인된 **단일 HTML 한 장**. */
  html: string;
  /**
   * 이 작품을 만든 Studio 세션 id (스풀 디렉토리 이름). 없으면 생략한다.
   *
   * 신원이 아니라 **가리키는 손가락**이다 — 누구 작품인지는 여전히 토큰이 정한다.
   * 이게 있어야 나중에 그 아이의 리포트를 만들 때 어느 세션 로그를 읽을지 확정된다.
   * 이름·시각으로 되짚으면 "가장 가까운 세션" 같은 추측이 되고, 틀리면 **남의
   * 로그로 만든 리포트**가 아이에게 간다.
   */
  sessionId?: string | null;
  fetchImpl?: typeof fetch;
}

export type PublishResult =
  | { ok: true; url: string; displayName: string }
  /**
   * 실패는 삼키지 않는다 — 명시적인 사용자 액션의 결과라 화면이 이유를 말해야
   * 한다. `message` 는 서버가 이미 한국어로 만들어 준 문구를 그대로 쓰고,
   * 서버에 닿지도 못했을 때만 여기서 문구를 만든다.
   */
  | { ok: false; status: number; message: string };

/**
 * `<title>` 에서 세상 이름을 뽑는다. 스켈레톤이 `%%TITLE%%` 자리에 아이가 정한
 * 이름을 넣어 두므로 이것이 가장 정확한 출처다 — 아이가 세상을 고치면 제목도
 * 같이 바뀌고, 갤러리에는 **그 시점의 제목**이 남아야 한다.
 */
export function extractTitle(html: string, fallback = "이름 없는 세상"): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return fallback;
  const t = m[1]
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // 스켈레톤이 아직 안 채워진 상태(`%%TITLE%%`)를 제목으로 올리지 않는다.
  if (!t || /^%%.*%%$/.test(t)) return fallback;
  return t.slice(0, 80);
}

/** 설정값을 신뢰하기 전에 모양을 본다. 빈 값·상대경로면 프로덕션으로 떨어진다. */
export function resolveSiteBase(configured: string | undefined | null): string {
  const v = (configured ?? "").trim().replace(/\/+$/, "");
  if (!v) return SITE_BASE_PROD;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? v : SITE_BASE_PROD;
  } catch {
    return SITE_BASE_PROD;
  }
}

export async function publishWorld(input: PublishInput): Promise<PublishResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const url = `${input.siteBase.replace(/\/+$/, "")}/api/gallery/publish`;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.token}`,
      },
      body: JSON.stringify({
        worldId: input.worldId,
        title: input.title,
        html: input.html,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      }),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: `인터넷에 연결되지 않았어요 (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  let body: { ok?: boolean; url?: string; displayName?: string; message?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* 본문이 JSON 이 아니면 아래에서 상태 코드만으로 답한다. */
  }

  if (!res.ok || body.ok !== true) {
    return {
      ok: false,
      status: res.status,
      message: body.message ?? `올리지 못했어요 (${res.status})`,
    };
  }

  // 서버가 준 경로를 사이트 주소에 붙여 아이가 그대로 열 수 있는 링크로 만든다.
  // 경로를 클라이언트가 조립하지 않는 이유: 코호트마다 갤러리 위치가 다를 수
  // 있고, 그 결정은 서버 한 곳에만 있어야 한다.
  const path = body.url ?? "/";
  return {
    ok: true,
    url: path.startsWith("http") ? path : `${input.siteBase.replace(/\/+$/, "")}${path}`,
    displayName: body.displayName ?? "",
  };
}
