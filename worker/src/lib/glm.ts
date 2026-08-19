/**
 * GLM (Z.ai) — Anthropic 호환 경로.
 *
 * 이 파일이 얇은 이유: **GLM 이 Anthropic 메시지 API 와 같은 모양으로 답한다.**
 * 그래서 요청/응답 파싱·SSE tap·usage 추출을 새로 쓰지 않고 `lib/anthropic.ts` 를
 * 그대로 재사용하고, 여기서는 **엔드포인트와 키만 갈아끼운다.**
 *
 * 실측 (2026-08-18, hypeprooflab#545):
 *
 *   POST https://api.z.ai/api/anthropic/v1/messages  → 200
 *   {"type":"message","content":[{"type":"text","text":"ok"}],
 *    "usage":{"input_tokens":13,"output_tokens":2,"cache_read_input_tokens":0}}
 *
 * 공식 문서(docs.z.ai)에는 OpenAI 호환만 적혀 있고 이 경로는 없다. 두드려서 확인했다.
 * 문서에 없다고 없는 것이 아니었다 — 바꾸기 전에 다시 두드려 볼 것.
 *
 * ## 캐시 — 자동이 아니다
 *
 * 같은 프리픽스를 반복해도 캐시가 걸리지 않는다. Anthropic 처럼
 * `cache_control: {type:"ephemeral"}` 을 **명시해야** 걸린다. 실측:
 *
 *   암묵 반복        input 2673 · cache_read    0
 *   cache_control    input   49 · cache_read 2624   ← 98% 가 캐시로
 *
 * 단가로는 $1.4/1M → $0.26/1M 이므로 그 부분만 81% 절감이다. 즉 **"컨텍스트가
 * 반복되니 저절로 싸진다" 는 성립하지 않는다.** 프롬프트를 만드는 쪽에서 캐시 지시를
 * 넣어야 하고, 그 작업은 이 wrapper 밖이다.
 *
 * 캐시 '쓰기'(Anthropic 의 cache_creation_input_tokens)에 해당하는 필드는 응답에
 * 없다. 따라서 usage_log.cache_write 는 GLM 에서 항상 0 이다 — 0 으로 기록되는 것과
 * "측정하지 않았다" 를 혼동하지 마라.
 */

export const GLM_ANTHROPIC_URL = "https://api.z.ai/api/anthropic/v1/messages";

/** OpenAI 호환 경로. 지금 쓰지 않지만, 문서상 정본이라 남겨 둔다. */
export const GLM_OPENAI_BASE = "https://api.z.ai/api/paas/v4";

/**
 * GLM 으로 보낼 때의 upstream URL.
 *
 * `callAnthropic(body, key, { url })` 에 그대로 넘긴다. Anthropic 용 프록시
 * (ANTHROPIC_PROXY_URL) 는 **쓰지 않는다** — 그 프록시는 지역 차단된
 * api.anthropic.com 을 우회하려고 둔 것이고, z.ai 는 그 문제가 없다.
 */
export function glmUpstreamUrl(): string {
  return GLM_ANTHROPIC_URL;
}
