// 붙여넣은 이미지를 워크스페이스 파일로 남기기 위한 순수 헬퍼 (#421).
//
// 왜 순수 모듈인가: chatPanelProvider 는 vscode API 에 묶여 있어 노드에서 단위
// 테스트가 안 된다. 판정(어떤 data URL 을 받아들일지)과 이름 짓기, 코치에게
// 넘길 문구는 전부 여기에 두고 호스트는 파일 쓰기만 한다.
//
// 배경: 웹뷰는 이미 바이트를 들고 있다 — `fitPastedImage` 가 File 을 data URL 로
// 읽고, 큰 것은 캔버스로 줄여 JPEG 로 재인코딩한다(#389). 그런데 그 바이트는
// 모델로만 가고 **디스크에는 남지 않았다.** 그래서 코치가 `<img src>` 로 걸
// 대상이 없어 "파일로 저장해 달라"고 참가자에게 되물었다.

/** 받아들이는 이미지 타입 → 확장자. 이 목록에 없으면 저장하지 않는다. */
const IMAGE_MIME_EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** 저장 대상 하위 폴더 (워크스페이스 루트 기준). */
export const PASTED_IMAGE_DIR = "assets";

/**
 * data URL 한 장의 해석 결과. `base64` 는 호스트가 그대로 Buffer 로 바꿔 쓴다
 * (여기서 디코드하지 않는 이유: 순수 모듈을 노드 Buffer 에 묶지 않기 위해).
 */
export interface ParsedPastedImage {
  mime: string;
  ext: string;
  base64: string;
}

/**
 * `data:image/png;base64,…` 를 해석한다. 이미지가 아니거나 base64 가 아니거나
 * 알 수 없는 타입이면 null.
 *
 * 화이트리스트인 이유: 이 값은 웹뷰(샌드박스 iframe)에서 온다. 지금은 우리
 * 코드만 보내지만, 저장 경로가 생긴 이상 "무엇이든 디스크에 쓸 수 있는" 문을
 * 열어 두지 않는다. 확장자도 mime 에서만 뽑는다 — 파일명은 참가자·모델 어느
 * 쪽에서도 오지 않는다.
 */
export function parsePastedImage(dataUrl: unknown): ParsedPastedImage | null {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = IMAGE_MIME_EXT[mime];
  if (!ext) return null;
  const base64 = m[2].replace(/\s+/g, "");
  if (!base64) return null;
  return { mime, ext, base64 };
}

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 저장할 파일 이름. `pasted-20260802-143012-1.png` 꼴.
 *
 * 시각을 넣는 이유: 참가자가 한 세션에서 여러 장을 붙여넣는다. 순번만 쓰면
 * 다음 턴의 1번이 이전 턴의 1번을 덮어쓴다. `dedupe` 는 같은 초에 같은 순번이
 * 이미 있을 때 호스트가 올려 가며 빈 이름을 찾는 용도다.
 */
export function pastedImageName(at: Date, index: number, ext: string, dedupe = 0): string {
  const stamp =
    `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}` +
    `-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  const suffix = dedupe > 0 ? `-${dedupe + 1}` : "";
  return `pasted-${stamp}-${index}${suffix}.${ext}`;
}

/**
 * 코치에게 붙여 보낼 블록. **두 런타임 모두** 이 문구를 본다 — 호출부가
 * `userTextForModel` 에 얹고, 그 값이 프록시·SDK 양쪽으로 같이 나간다.
 *
 * 문구가 이렇게 단정적인 이유는 실사용 발화 때문이다 (2026-07-24 실강의):
 * 코치가 "워크스페이스에 이미지 파일이 없어요 … 파일로 저장해 주시겠어요?"
 * 라고 참가자에게 일을 떠넘겼다. 파일이 생긴 뒤에도 같은 말을 하지 않도록,
 * 존재를 사실로 알려 주고 되묻기를 명시적으로 막는다.
 */
export function pastedImageNote(relPaths: readonly string[], cwd: string): string {
  if (relPaths.length === 0) return "";
  const lines = relPaths.map((p) => `  ${p}`).join("\n");
  return [
    "<pasted-images>",
    `참가자가 방금 붙여넣은 이미지 ${relPaths.length}장을 작업 폴더에 파일로 저장했다.`,
    `작업 폴더: ${cwd}`,
    lines,
    "페이지에 넣을 때는 위 상대경로를 그대로 `<img src>` 에 쓴다(라이브 서버가 같은 폴더를 서빙한다).",
    "이미 디스크에 있는 파일이다 — 참가자에게 저장해 달라고 요청하지 않고, 있는지 다시 묻지도 않는다.",
    "</pasted-images>",
  ].join("\n");
}

/**
 * 저장 실패를 참가자에게 보일 한 줄. 조용히 실패하면 코치는 다시 "파일이
 * 없어요" 상태로 돌아가는데 아무도 이유를 모른다.
 */
export function pastedImageFailureLabel(count: number): string {
  return `이미지 ${count}장을 작업 폴더에 저장하지 못했어요`;
}

/** 저장 성공을 참가자에게 보일 한 줄 (agent.md 저장 표시와 같은 계열). */
export function pastedImageSavedLabel(relPaths: readonly string[]): string {
  return relPaths.length === 1
    ? `이미지 저장됨 — ${relPaths[0]}`
    : `이미지 ${relPaths.length}장 저장됨 — ${relPaths.join(" · ")}`;
}
