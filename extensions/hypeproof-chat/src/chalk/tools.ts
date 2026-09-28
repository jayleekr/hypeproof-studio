// Chalk 도구 층 (E4-2 / #1297, E2-6 / #1295).
//
// 도구는 한 벌이다(SUB-07): 버튼·Claude MCP·Codex dynamicTools 셋 다
// 여기 정의된 실행 함수를 부른다. 판단 로직은 없다 — 서버가 판정한다.
// 인증은 저장된 issuer 토큰. 토큰은 서버로만 가고 모델 입력·결과에 섞이지 않는다.
//
// E4-2 (#1297): chalk_check_plan · chalk_get_knowledge · chalk_recommend_methods
// E2-6 (#1295): chalk_set_inputs · chalk_generator_brief · chalk_open_course · chalk_save_plan

import type * as vscode from "vscode";
import * as nodePath from "node:path";
import * as nodeFs from "node:fs/promises";

// ─── 공통 타입 ─────────────────────────────────────────────────────────────

export interface ChalkToolContext {
  /** 서버 base URL (proxyUrl). 토큰도 이 서버로만 보낸다. */
  serverUrl: string;
  /** VS Code SecretStorage — issuer 토큰을 꺼낼 때만 쓴다. 결과·로그에 토큰을 두지 않는다. */
  secrets: vscode.SecretStorage;
  /** AbortSignal: 사용자가 중단하면 in-flight 요청도 끊는다. */
  signal?: AbortSignal;
  /**
   * 강사 작업 폴더 (cwd). 작업 사본 파일(chalk/<course>/지도안.html)을 여기에 쓴다.
   * chalk_open_course · chalk_generator_brief · chalk_save_plan 이 사용한다.
   */
  cwd?: string;
  /**
   * 덮어쓰기 전에 강사에게 물을 때 호출하는 콜백 (extension.ts 쪽이 VS Code modal로 구현).
   * `true` 반환 → 진행, `false` → 취소.
   */
  requestConfirmation?: (message: string) => Promise<boolean>;
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

// #1297 (E4-2): first-pass filter — token presence + unverified claim.
// Final gate is server-verified whoami in chatPanelProvider (#1298, E4-3).
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

export class IssuerHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`서버 오류 ${status}`);
    this.name = "IssuerHttpError";
    this.status = status;
    this.body = body;
  }
}

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
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }

  if (!res.ok) {
    throw new IssuerHttpError(res.status, parsed);
  }
  return parsed;
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

  try {
    return await issuerFetch(
      ctx,
      `/admin/chalk/cohorts/${encodeURIComponent(cohort)}/courses/${encodeURIComponent(course)}/recommend`,
      { method: "POST", body },
    );
  } catch (e) {
    if (e instanceof IssuerHttpError) {
      const b = e.body as Record<string, unknown> | null;
      const code = typeof b?.code === "string" ? b.code : null;
      if (e.status === 409 && (code === "knowledge_missing" || code === "knowledge_incomplete")) {
        throw new Error("지식이 적재되지 않았습니다. 먼저 지식을 적재하세요.");
      }
      if (e.status === 409 && code === "knowledge_incompatible") {
        const unranked = (b as Record<string, unknown>)?.unranked;
        throw new Error(
          `제품 지식과 앱 버전이 맞지 않습니다. unranked=${JSON.stringify(unranked)}`,
        );
      }
      if (e.status === 400 && code === "vocab_unknown") {
        throw new Error(
          `입력 오류: field=${JSON.stringify(b?.field)}, unknown_values=${JSON.stringify(b?.unknown_values)}`,
        );
      }
    }
    throw e;
  }
}

// ─── GEN-APP 내부 유틸 ────────────────────────────────────────────────────

/**
 * 로컬 작업 사본 경로. cohort를 포함하지 않는다 — 같은 강의는 코호트 무관하게 한 사본.
 * file 별로 다른 파일(lesson.html, ops.html)을 쓴다. 기본은 lesson.html.
 */
export function workingCopyPath(cwd: string, course: string, file?: string): string {
  const fname = file ? `${file}.html` : "lesson.html";
  return nodePath.join(cwd, "chalk", course, fname);
}

async function hasLocalChanges(filePath: string): Promise<boolean> {
  try {
    const stat = await nodeFs.stat(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

// ─── GEN-APP 도구 정의 ────────────────────────────────────────────────────

// chalk_set_inputs — PUT /admin/chalk/cohorts/:cohort/courses/:course/inputs
export const CHALK_SET_INPUTS_DEF: ChalkToolDefinition = {
  name: "chalk_set_inputs",
  description:
    "강의 생성기 입력값(학습 조건·목표·교수 모형 등)을 설정합니다. 이후 chalk_generator_brief로 지식 기반 브리프를 생성합니다.",
  inputSchema: schema(
    {
      cohort: { ...str, description: "코호트 ID" },
      course: { ...str, description: "강의 ID" },
      audience: { ...str, description: "수강 대상 설명 (예: 초등 3~4학년 20명)" },
      assets: {
        type: "array",
        items: {
          type: "string",
          enum: ["TASTE", "INTENT", "CONTEXT", "VERIFY", "DELEGATE", "ITERATE", "OWNERSHIP"],
        },
        description: "7대 AI Native Asset 중 이 강의에서 다룰 항목",
      },
      teaching_style: { ...str, description: "교수 스타일 또는 방법론 (예: 탐구 학습)" },
      requirements: { type: "string", description: "기타 요구사항 또는 제약 (빈 문자열 허용)" },
      format: { type: "string", enum: ["workshop", "track"], description: "강의 형식" },
      expected_revision: { type: "number", description: "현재 초안 리비전 번호 (≥1)" },
      request_id: { ...str, description: "중복 방지용 고유 요청 ID (영문숫자·-·_ 조합, 최대 128자)" },
      family_session: { type: "boolean", description: "가족 세션 여부 (선택)" },
      vocab: {
        type: "object",
        properties: {
          goals: { type: "array", items: { type: "string" }, description: "어휘 목표 키 목록" },
          conditions: { type: "array", items: { type: "string" }, description: "어휘 조건 키 목록" },
        },
        additionalProperties: false,
        description: "어휘 필터 (선택)",
      },
    },
    ["cohort", "course", "audience", "assets", "teaching_style", "requirements", "format", "expected_revision", "request_id"],
  ),
};

export async function execSetInputs(
  ctx: ChalkToolContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { cohort, course, ...body } = input as {
    cohort: string;
    course: string;
    [k: string]: unknown;
  };
  if (!cohort || !course) throw new Error("cohort와 course는 필수입니다.");
  try {
    return await issuerFetch(
      ctx,
      `/admin/chalk/cohorts/${encodeURIComponent(cohort)}/courses/${encodeURIComponent(course)}/inputs`,
      { method: "PUT", body },
    );
  } catch (e) {
    if (e instanceof IssuerHttpError) {
      const b = e.body as Record<string, unknown> | null;
      const code = typeof b?.code === "string" ? b.code : null;
      if (e.status === 409) {
        if (code === "revision_conflict") return { error: "revision_conflict", message: "버전 충돌이 발생했습니다. chalk_open_course로 최신 버전을 불러온 뒤 다시 시도하세요." };
        if (code === "knowledge_missing") return { error: "knowledge_missing", message: "지식이 적재되지 않았습니다. 먼저 지식을 적재하세요." };
        if (code === "inputs_missing") return { error: "inputs_missing", message: "필수 입력값이 없습니다. 입력값을 확인하세요." };
      }
    }
    throw e;
  }
}

// chalk_generator_brief — GET /admin/chalk/cohorts/:cohort/courses/:course/brief?file=<file>
export const CHALK_GENERATOR_BRIEF_DEF: ChalkToolDefinition = {
  name: "chalk_generator_brief",
  description:
    "설정된 입력값과 지식 저장소를 기반으로 강의 생성 브리프를 가져옵니다. chalk_set_inputs 완료 후 호출합니다.",
  inputSchema: schema(
    {
      cohort: { ...str, description: "코호트 ID" },
      course: { ...str, description: "강의 ID" },
      file: { ...str, description: "파일 키 (예: lesson). 서버가 스켈레톤을 선택하는 데 사용합니다." },
    },
    ["cohort", "course"],
  ),
};

export async function execGeneratorBrief(
  ctx: ChalkToolContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { cohort, course, file } = input as { cohort: string; course: string; file?: string };
  if (!cohort || !course) throw new Error("cohort와 course는 필수입니다.");
  const qs = file ? `?file=${encodeURIComponent(file)}` : "";
  try {
    return await issuerFetch(
      ctx,
      `/admin/chalk/cohorts/${encodeURIComponent(cohort)}/courses/${encodeURIComponent(course)}/brief${qs}`,
    );
  } catch (e) {
    if (e instanceof IssuerHttpError) {
      const b = e.body as Record<string, unknown> | null;
      const code = typeof b?.code === "string" ? b.code : null;
      if (e.status === 409) {
        if (code === "inputs_missing") return { error: "inputs_missing", message: "입력값이 없습니다. chalk_set_inputs로 먼저 입력값을 설정하세요." };
        if (code === "knowledge_missing") return { error: "knowledge_missing", message: "지식이 적재되지 않았습니다. 먼저 지식을 적재하세요." };
        if (code === "knowledge_incomplete") return { error: "knowledge_incomplete", message: "지식이 불완전합니다. 지식 버전을 확인하세요." };
        if (code === "knowledge_incompatible") return { error: "knowledge_incompatible", message: "지식이 호환되지 않습니다. 다른 지식 버전을 선택하세요.", field: (b as Record<string, unknown>)?.field, unranked: (b as Record<string, unknown>)?.unranked };
      }
    }
    throw e;
  }
}

// chalk_open_course — GET /admin/chalk/cohorts/:cohort/courses/:course/plan?file=<file>
// 서버에서 HTML 계획서를 받아 로컬 작업 사본(cwd/chalk/<course>/지도안.html)에 쓴다.
export const CHALK_OPEN_COURSE_DEF: ChalkToolDefinition = {
  name: "chalk_open_course",
  description:
    "저장된 강의 계획서(HTML)를 서버에서 불러와 로컬 작업 사본으로 엽니다. 기존 파일이 있으면 덮어쓰기 전 확인을 요청합니다.",
  inputSchema: schema(
    {
      cohort: { ...str, description: "코호트 ID" },
      course: { ...str, description: "강의 ID" },
      file: { ...str, description: "파일 키 (예: lesson). 서버에서 가져올 파일을 지정합니다." },
    },
    ["cohort", "course"],
  ),
};

export async function execOpenCourse(
  ctx: ChalkToolContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { cohort, course, file } = input as { cohort: string; course: string; file?: string };
  if (!cohort || !course) throw new Error("cohort와 course는 필수입니다.");

  const qs = file ? `?file=${encodeURIComponent(file)}` : "";
  const result = await issuerFetch(
    ctx,
    `/admin/chalk/cohorts/${encodeURIComponent(cohort)}/courses/${encodeURIComponent(course)}/plan${qs}`,
  ) as { html?: string; [k: string]: unknown };

  const html = result?.html;
  // cwd 없거나 html 없으면 원격 응답만 반환
  if (typeof html !== "string" || !ctx.cwd) return result;

  const dest = workingCopyPath(ctx.cwd, course, file);

  if (await hasLocalChanges(dest)) {
    const confirmed = await ctx.requestConfirmation?.(
      `기존 작업 사본(${dest})을 덮어씁니다. 계속하시겠습니까?`,
    );
    if (confirmed === false) return { overwrite_skipped: true };
  }

  await nodeFs.mkdir(nodePath.dirname(dest), { recursive: true });
  await nodeFs.writeFile(dest, html, "utf8");
  return { ...result, localPath: dest };
}

// chalk_save_plan — PUT /admin/chalk/cohorts/:cohort/courses/:course/plan
// 로컬 작업 사본을 읽어 서버에 저장한다.
export const CHALK_SAVE_PLAN_DEF: ChalkToolDefinition = {
  name: "chalk_save_plan",
  description:
    "로컬 작업 사본(<file>.html)을 서버에 저장합니다. 저장 전 로컬 파일을 읽습니다.",
  inputSchema: schema(
    {
      cohort: { ...str, description: "코호트 ID" },
      course: { ...str, description: "강의 ID" },
      file: { ...str, description: "파일 키 (lesson 또는 ops). 기본값: lesson" },
    },
    ["cohort", "course"],
  ),
};

export async function execSavePlan(
  ctx: ChalkToolContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { cohort, course, file } = input as { cohort: string; course: string; file?: string };
  if (!cohort || !course) throw new Error("cohort와 course는 필수입니다.");
  if (!ctx.cwd) throw new Error("작업 폴더(cwd)가 설정되지 않았습니다.");

  const src = workingCopyPath(ctx.cwd, course, file);
  let html: string;
  try {
    html = await nodeFs.readFile(src, "utf8");
  } catch {
    throw new Error(`로컬 작업 사본(${src})을 읽을 수 없습니다. chalk_open_course로 먼저 열어보세요.`);
  }

  // 서버 body에는 html 외 추가 필드(knowledge_version, expected_revision, request_id)도 포함한다.
  const { cohort: _c, course: _co, file: _f, ...extras } = input as Record<string, unknown>;
  try {
    return await issuerFetch(
      ctx,
      `/admin/chalk/cohorts/${encodeURIComponent(cohort)}/courses/${encodeURIComponent(course)}/plan`,
      { method: "PUT", body: { html, ...extras } },
    );
  } catch (e) {
    if (e instanceof IssuerHttpError) {
      const b = e.body as Record<string, unknown> | null;
      const code = typeof b?.code === "string" ? b.code : null;
      if (e.status === 409) {
        if (code === "revision_conflict") return { error: "revision_conflict", message: "버전 충돌이 발생했습니다. chalk_open_course로 최신 버전을 불러온 뒤 다시 시도하세요." };
        if (code === "knowledge_missing") return { error: "knowledge_missing", message: "지식이 적재되지 않았습니다. 먼저 지식을 적재하세요." };
      }
    }
    throw e;
  }
}

// ─── 도구 묶음 ─────────────────────────────────────────────────────────────

export const CHALK_TOOL_DEFINITIONS: ChalkToolDefinition[] = [
  CHALK_CHECK_PLAN_DEF,
  CHALK_GET_KNOWLEDGE_DEF,
  CHALK_RECOMMEND_METHODS_DEF,
  CHALK_SET_INPUTS_DEF,
  CHALK_GENERATOR_BRIEF_DEF,
  CHALK_OPEN_COURSE_DEF,
  CHALK_SAVE_PLAN_DEF,
];

type ExecutorMap = Record<
  string,
  (ctx: ChalkToolContext, input: Record<string, unknown>) => Promise<unknown>
>;

export const CHALK_TOOL_EXECUTORS: ExecutorMap = {
  chalk_check_plan: execCheckPlan,
  chalk_get_knowledge: execGetKnowledge,
  chalk_recommend_methods: execRecommendMethods,
  chalk_set_inputs: execSetInputs,
  chalk_generator_brief: execGeneratorBrief,
  chalk_open_course: execOpenCourse,
  chalk_save_plan: execSavePlan,
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
