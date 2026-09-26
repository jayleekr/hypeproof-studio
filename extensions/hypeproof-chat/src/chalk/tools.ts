// Chalk 도구 층 (E4-2 / #1297).
//
// 도구는 한 벌이다(SUB-07): 버튼·Claude MCP·Codex dynamicTools 셋 다
// 여기 정의된 실행 함수를 부른다. 판단 로직은 없다 — 서버가 판정한다.
// 인증은 저장된 issuer 토큰. 토큰은 서버로만 가고 모델 입력·결과에 섞이지 않는다.
//
// 이번 PR 에 넣는 도구: chalk_check_plan · chalk_get_knowledge · chalk_recommend_methods.
// 나머지(set_inputs·save_plan·generator_brief)는 E2-6 에서 추가한다.

import type * as vscode from "vscode";

// ─── 공통 타입 ─────────────────────────────────────────────────────────────

export interface ChalkToolContext {
  /** 서버 base URL (proxyUrl). 토큰도 이 서버로만 보낸다. */
  serverUrl: string;
  /** VS Code SecretStorage — issuer 토큰을 꺼낼 때만 쓴다. 결과·로그에 토큰을 두지 않는다. */
  secrets: vscode.SecretStorage;
  /** AbortSignal: 사용자가 중단하면 in-flight 요청도 끊는다. */
  signal?: AbortSignal;
}

export interface ChalkToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

// ─── 강사 모드 판정 ────────────────────────────────────────────────────────

// #1297 (E4-2): issuer 토큰 존재 + 클레임 해석으로 판정한다.
// E4-3 (#1296)에서 GET /admin/chalk/whoami 서버 확인으로 교체한다.
import { ISSUER_TOKEN_KEY } from "../mintStudentTokenHelpers.ts";
import { looksLikeIssuerTokenUnverified } from "../chatPanelHelpers.ts";

export async function chalkToolsEnabled(
  secrets: vscode.SecretStorage,
): Promise<boolean> {
  const token = await secrets.get(ISSUER_TOKEN_KEY);
  if (!token) return false;
  return looksLikeIssuerTokenUnverified(token);
}

// ─── 내부 유틸 ─────────────────────────────────────────────────────────────

async function issuerFetch(
  ctx: ChalkToolContext,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const token = await ctx.secrets.get(ISSUER_TOKEN_KEY);
  if (!token) throw new Error("강사 토큰이 없습니다. 먼저 로그인하세요.");

  const base = ctx.serverUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const res = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: ctx.signal,
  });

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 409) {
      throw new Error("지식이 적재되지 않았습니다. 먼저 지식을 적재하세요.");
    }
    throw new Error(`서버 오류 ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─── 도구 정의 ─────────────────────────────────────────────────────────────

const schema = (
  properties: Record<string, unknown>,
  required: string[],
): ChalkToolDefinition["inputSchema"] => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const str = { type: "string" };

// chalk_check_plan — POST /admin/chalk/cohorts/:cohort/courses/:course/check
// (#1294 경로)
export const CHALK_CHECK_PLAN_DEF: ChalkToolDefinition = {
  name: "chalk_check_plan",
  description:
    "저장된 초안을 검사해 규격 위반·관문 판정 결과를 돌려줍니다. 선택적으로 HTML 본문을 직접 넣어 파서 검사만 먼저 받을 수 있습니다.",
  inputSchema: schema(
    {
      cohort: { ...str, description: "코호트 ID (예: sk-biopharm-kids-s1)" },
      course: { ...str, description: "강의 ID (예: lesson-01)" },
      html: {
        type: "string",
        description: "계획서 HTML. 생략하면 저장된 초안으로 검사합니다.",
      },
    },
    ["cohort", "course"],
  ),
};

export async function execCheckPlan(
  ctx: ChalkToolContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { cohort, course, html } = input as {
    cohort: string;
    course: string;
    html?: string;
  };
  if (!cohort || !course) throw new Error("cohort와 course는 필수입니다.");
  const body = html !== undefined ? { html } : {};
  return issuerFetch(
    ctx,
    `/admin/chalk/cohorts/${encodeURIComponent(cohort)}/courses/${encodeURIComponent(course)}/check`,
    { method: "POST", body },
  );
}

// chalk_get_knowledge — #1288 경로 세 가지:
//   version 없음          → GET /admin/chalk/knowledge/versions (버전 목록)
//   version + doc_id      → GET /admin/chalk/knowledge/:version/docs/:doc_id (URL 인코딩 필수; doc_id에 ':' 포함)
//   version (+ kind 선택) → GET /admin/chalk/knowledge/:version/docs?kind=<kind>
export const CHALK_GET_KNOWLEDGE_DEF: ChalkToolDefinition = {
  name: "chalk_get_knowledge",
  description:
    "Chalk 지식 저장소에서 문서를 읽습니다. version 생략 시 버전 목록, doc_id 지정 시 단일 문서, kind 지정 시 해당 종류 목록을 돌려줍니다.",
  inputSchema: schema(
    {
      version: { type: "number", description: "지식 버전 (예: 3). 생략하면 버전 목록을 돌려줍니다." },
      kind: {
        ...str,
        description: "문서 종류 (예: method, guide). version과 함께 지정하면 해당 종류만 필터합니다.",
      },
      doc_id: {
        ...str,
        description: "문서 ID (예: method:m-001). version과 함께 지정하면 해당 문서 하나를 돌려줍니다.",
      },
    },
    [],
  ),
};

export async function execGetKnowledge(
  ctx: ChalkToolContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { version, kind, doc_id } = input as {
    version?: number;
    kind?: string;
    doc_id?: string;
  };

  // 버전 없음 → 버전 목록
  if (version === undefined || version === null) {
    return issuerFetch(ctx, `/admin/chalk/knowledge/versions`);
  }

  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error("version은 양의 정수여야 합니다.");
  }

  const ver = encodeURIComponent(String(version));

  // doc_id 있음 → 단일 문서 (doc_id에 ':' 포함 가능 → encodeURIComponent 필수)
  if (doc_id) {
    return issuerFetch(ctx, `/admin/chalk/knowledge/${ver}/docs/${encodeURIComponent(doc_id)}`);
  }

  // kind 있음 → 쿼리스트링으로 필터
  const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  return issuerFetch(ctx, `/admin/chalk/knowledge/${ver}/docs${qs}`);
}

// chalk_recommend_methods — POST /admin/chalk/cohorts/:cohort/courses/:course/recommend
// (#1293 경로; cohort는 도구 입력으로 받는다 — 강사 토큰 scope에 코호트가 여럿일 수 있기 때문)
export const CHALK_RECOMMEND_METHODS_DEF: ChalkToolDefinition = {
  name: "chalk_recommend_methods",
  description:
    "강의 초안의 학습 조건·목표를 기반으로 적합한 교수 모형을 추천합니다.",
  inputSchema: schema(
    {
      cohort: { ...str, description: "코호트 ID (예: sk-biopharm-kids-s1). 강사 토큰 scope에서 선택" },
      course: { ...str, description: "강의 ID (예: lesson-01)" },
      conditions: {
        type: "array",
        items: { type: "string" },
        description: "학습 조건 목록 (예: [\"no_prior\", \"short_time\"])",
      },
      goals: {
        type: "array",
        items: { type: "string" },
        description: "학습 목표 목록 (예: [\"concept_understanding\"])",
      },
      knowledge_version: {
        type: "number",
        description: "지식 버전. 생략 시 서버가 최신 버전을 사용합니다.",
      },
      learner_level: { ...str, description: "학습자 수준 (optional, 예: beginner)" },
      has_guidance: { type: "boolean", description: "교사 지도 여부 (optional)" },
    },
    ["cohort", "course", "conditions", "goals"],
  ),
};

export async function execRecommendMethods(
  ctx: ChalkToolContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { cohort, course, conditions, goals, knowledge_version, learner_level, has_guidance } =
    input as {
      cohort: string;
      course: string;
      conditions: string[];
      goals: string[];
      knowledge_version?: number;
      learner_level?: string;
      has_guidance?: boolean;
    };
  if (!cohort || !course) throw new Error("cohort와 course는 필수입니다.");
  if (!Array.isArray(conditions) || !Array.isArray(goals)) {
    throw new Error("conditions와 goals는 배열이어야 합니다.");
  }
  const body: Record<string, unknown> = { conditions, goals };
  if (knowledge_version !== undefined) body.knowledge_version = knowledge_version;
  if (learner_level !== undefined) body.learner_level = learner_level;
  if (has_guidance !== undefined) body.has_guidance = has_guidance;

  return issuerFetch(
    ctx,
    `/admin/chalk/cohorts/${encodeURIComponent(cohort)}/courses/${encodeURIComponent(course)}/recommend`,
    { method: "POST", body },
  );
}

// ─── 도구 묶음 ─────────────────────────────────────────────────────────────

export const CHALK_TOOL_DEFINITIONS: ChalkToolDefinition[] = [
  CHALK_CHECK_PLAN_DEF,
  CHALK_GET_KNOWLEDGE_DEF,
  CHALK_RECOMMEND_METHODS_DEF,
];

type ExecutorMap = Record<
  string,
  (ctx: ChalkToolContext, input: Record<string, unknown>) => Promise<unknown>
>;

export const CHALK_TOOL_EXECUTORS: ExecutorMap = {
  chalk_check_plan: execCheckPlan,
  chalk_get_knowledge: execGetKnowledge,
  chalk_recommend_methods: execRecommendMethods,
};

/**
 * 도구 이름으로 실행 함수를 부른다.
 * 결과는 JSON 문자열로 직렬화된다 — 모델이 읽는 tool_result 형식.
 * 토큰은 이 함수가 반환하는 문자열에 포함되지 않는다.
 */
export async function callChalkTool(
  ctx: ChalkToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const executor = CHALK_TOOL_EXECUTORS[name];
  if (!executor) throw new Error(`알 수 없는 Chalk 도구: ${name}`);
  const result = await executor(ctx, input);
  return JSON.stringify(result);
}
