// Chalk 도구 층 (E4-2 / #1297, E2-6 / #1295).
//
// 도구는 한 벌이다(SUB-07): 버튼·Claude MCP·Codex dynamicTools 셋 다
// 여기 정의된 실행 함수를 부른다. 판단 로직은 없다 — 서버가 판정한다.
// 인증은 저장된 issuer 토큰. 토큰은 서버로만 가고 모델 입력·결과에 섞이지 않는다.
//
// 이번 PR(#1295, E2-6)에 추가하는 도구:
//   chalk_set_inputs · chalk_generator_brief · chalk_save_plan · chalk_open_course

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
  if (!res.ok) {
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    throw new IssuerHttpError(res.status, body);
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

  try {
    return await issuerFetch(
      ctx,
      `/admin/chalk/cohorts/${encodeURIComponent(cohort)}/courses/${encodeURIComponent(course)}/recommend`,
      { method: "POST", body },
    );
  } catch (err) {
    if (err instanceof IssuerHttpError && err.status === 409) {
      return { error: "지식이 적재되지 않았습니다. chalk_get_knowledge로 버전을 확인하세요." };
    }
    if (err instanceof IssuerHttpError && err.status === 400) {
      const b = err.body as { error?: string; field?: string; unknown_values?: string[] } | null;
      const field = b?.field ?? "";
      const unknown = b?.unknown_values ?? [];
      return { error: `어휘 오류 (${field}): 알 수 없는 값 [${unknown.join(", ")}]` };
    }
    throw err;
  }
}

// ─── 작업 사본 파일 유틸 ──────────────────────────────────────────────────

/** 강사 작업 폴더의 작업 사본 절대 경로. chalk/<course>/지도안.html 또는 운영안.html */
export function workingCopyPath(cwd: string, course: string, file: string): string {
  const fileName = file === "ops" ? "운영안.html" : "지도안.html";
  return nodePath.join(cwd, "chalk", course, fileName);
}

/** 로컬 변경 여부: 파일이 없으면 false, 서버본과 다르면 true */
async function hasLocalChanges(filePath: string, serverHtml: string): Promise<boolean> {
  try {
    const local = await nodeFs.readFile(filePath, "utf-8");
    return local.trimEnd() !== serverHtml.trimEnd();
  } catch {
    return false;
  }
}

// ─── E2-6 도구 추가 (#1295) ────────────────────────────────────────────────

// chalk_set_inputs — PUT /admin/chalk/cohorts/:cohort/courses/:course/inputs
// 입력 다섯 가지를 서버 초안에 기록한다.
export const CHALK_SET_INPUTS_DEF: ChalkToolDefinition = {
  name: "chalk_set_inputs",
  description:
    "강의 초안에 입력 다섯 가지(대상·자산·방식·요구·형식)와 모형 추천용 닫힌 어휘 키(vocab)를 저장합니다. " +
    "vocab.goals·vocab.conditions 키는 chalk_get_knowledge로 vocab:goal·vocab:condition 문서를 읽고 그 안에서만 골라야 합니다. " +
    "어휘 밖 키는 서버가 400으로 막습니다. 강사에게 선택 키를 어휘 문서의 label로 보여주고 확인을 받으세요.",
  inputSchema: schema(
    {
      cohort: { ...str, description: "코호트 ID. 강사 토큰 scope에서 선택" },
      course: { ...str, description: "강의 ID (예: lesson-01)" },
      audience: { ...str, description: "학습 대상 설명" },
      assets: {
        type: "array",
        items: { type: "string" },
        description: "적용할 7 AI Native Assets (예: [\"intent\",\"verify\"])",
      },
      teaching_style: { ...str, description: "수업 방식 설명" },
      requirements: { ...str, description: "강사 추가 요구사항" },
      format: {
        type: "string",
        enum: ["workshop", "track"],
        description: "수업 형식",
      },
      vocab: {
        type: "object",
        description: "모형 추천용 닫힌 어휘 키. chalk_get_knowledge(vocab:goal·vocab:condition)에서 고른 값만 유효",
        properties: {
          goals: { type: "array", items: { type: "string" }, description: "학습 목표 키 목록" },
          conditions: { type: "array", items: { type: "string" }, description: "학습 조건 키 목록" },
          learner_level: {
            type: "string",
            enum: ["novice", "intermediate", "any"],
            description: "학습자 수준",
          },
          has_guidance: { type: "boolean", description: "교사 지도 여부" },
        },
        required: ["goals", "conditions", "learner_level", "has_guidance"],
        additionalProperties: false,
      },
      expected_revision: { type: "number", description: "현재 초안 revision (충돌 방지)" },
      request_id: { ...str, description: "멱등 키 (UUID). 강사 세션마다 새 UUID" },
      profile_id: { ...str, description: "프로필 ID (신규 초안이면 생략)" },
    },
    ["cohort", "course", "audience", "assets", "teaching_style", "requirements", "format", "vocab", "expected_revision", "request_id"],
  ),
};

export async function execSetInputs(
  ctx: ChalkToolContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { cohort, course, audience, assets, teaching_style, requirements, format,
    vocab, expected_revision, request_id, profile_id } =
    input as {
      cohort: string; course: string;
      audience: string; assets: string[]; teaching_style: string;
      requirements: string; format: "workshop" | "track";
      vocab: { goals: string[]; conditions: string[]; learner_level: string; has_guidance: boolean };
      expected_revision: number; request_id: string; profile_id?: string;
    };
  if (!cohort || !course) throw new Error("cohort와 course는 필수입니다.");
  const body: Record<string, unknown> = {
    audience, assets, teaching_style, requirements, format,
    vocab, expected_revision, request_id,
  };
  if (profile_id !== undefined) body.profile_id = profile_id;
  try {
    return await issuerFetch(
      ctx,
      `/admin/chalk/cohorts/${encodeURIComponent(cohort)}/courses/${encodeURIComponent(course)}/inputs`,
      { method: "PUT", body },
    );
  } catch (err) {
    if (err instanceof IssuerHttpError && err.status === 409) {
      const b = err.body as { error?: string } | null;
      const msg = b?.error ?? "";
      if (msg.startsWith("제품 지식이 아직 없습니다")) {
        return { error: "지식이 적재되지 않았습니다. chalk_get_knowledge로 버전을 확인하세요." };
      }
      if (msg.startsWith("revision conflict")) {
        return { error: "revision_conflict", message: "다른 곳에서 저장됐습니다. chalk_open_course로 최신 버전을 다시 열고 변경을 다시 적용하세요." };
      }
      throw err;
    }
    throw err;
  }
}

// chalk_generator_brief — GET /admin/chalk/cohorts/:cohort/courses/:course/brief?file=
// 생성 지침 묶음(authoring_order·skeleton_html 등)을 가져오고 작업 사본 뼈대를 초기화한다.
export const CHALK_GENERATOR_BRIEF_DEF: ChalkToolDefinition = {
  name: "chalk_generator_brief",
  description:
    "생성 지침 묶음을 가져옵니다. skeleton_html을 강사 작업 폴더 chalk/<course>/지도안.html에 씁니다. 로컬 변경이 있으면 덮어쓰기 전에 확인합니다.",
  inputSchema: schema(
    {
      cohort: { ...str, description: "코호트 ID" },
      course: { ...str, description: "강의 ID" },
      file: { type: "string", enum: ["lesson", "ops"], description: "파일 종류 (기본: lesson)" },
    },
    ["cohort", "course"],
  ),
};

export async function execGeneratorBrief(
  ctx: ChalkToolContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { cohort, course, file = "lesson" } = input as {
    cohort: string; course: string; file?: string;
  };
  if (!cohort || !course) throw new Error("cohort와 course는 필수입니다.");

  let briefRaw: unknown;
  try {
    briefRaw = await issuerFetch(
      ctx,
      `/admin/chalk/cohorts/${encodeURIComponent(cohort)}/courses/${encodeURIComponent(course)}/brief?file=${encodeURIComponent(file)}`,
    );
  } catch (err) {
    if (err instanceof IssuerHttpError && err.status === 409) {
      const b = err.body as { error?: string; field?: string; unranked?: string[] } | null;
      const msg = b?.error ?? "";
      if (msg.startsWith("입력을 먼저 저장하세요")) {
        return { error: "inputs_missing", message: "입력을 먼저 저장하세요. chalk_set_inputs를 먼저 실행하세요." };
      }
      if (msg.startsWith("어휘(vocab)를 입력에 포함해야")) {
        return { error: "vocab_missing", message: "vocab을 입력에 포함해야 brief를 만들 수 있습니다. chalk_set_inputs에 vocab을 포함하세요." };
      }
      if (msg.startsWith("제품 지식이 아직 없습니다")) {
        return { error: "지식이 적재되지 않았습니다. chalk_get_knowledge로 버전을 확인하세요." };
      }
      if (msg === "knowledge incompatible") {
        return { error: "knowledge_incompatible", field: b?.field, unranked: b?.unranked };
      }
      throw err;
    }
    throw err;
  }
  const brief = briefRaw as { skeleton_html?: string };

  // 작업 사본에 뼈대 쓰기 (cwd가 있을 때만)
  if (ctx.cwd && brief.skeleton_html) {
    const filePath = workingCopyPath(ctx.cwd, course, file);
    const dirty = await hasLocalChanges(filePath, brief.skeleton_html);
    if (dirty) {
      const ok = await ctx.requestConfirmation?.(
        `chalk/${course}/지도안.html에 저장되지 않은 변경이 있습니다. 서버 뼈대로 덮어씁니까?`,
      );
      if (ok === false) {
        return { ...brief, local_file: filePath, overwrite_skipped: true };
      }
    }
    await nodeFs.mkdir(nodePath.dirname(filePath), { recursive: true });
    await nodeFs.writeFile(filePath, brief.skeleton_html, "utf-8");
    return { ...brief, local_file: filePath };
  }

  return brief;
}

// chalk_open_course — GET /admin/chalk/cohorts/:cohort/courses/:course/plan?file=
// 서버 계획서 원문을 가져와 작업 사본 파일로 연다.
export const CHALK_OPEN_COURSE_DEF: ChalkToolDefinition = {
  name: "chalk_open_course",
  description:
    "서버 계획서 원문(HTML)을 chalk/<course>/지도안.html에 가져옵니다. 로컬 변경이 있으면 덮어쓰기 전에 확인합니다.",
  inputSchema: schema(
    {
      cohort: { ...str, description: "코호트 ID" },
      course: { ...str, description: "강의 ID" },
      file: { type: "string", enum: ["lesson", "ops"], description: "파일 종류 (기본: lesson)" },
    },
    ["cohort", "course"],
  ),
};

export async function execOpenCourse(
  ctx: ChalkToolContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { cohort, course, file = "lesson" } = input as {
    cohort: string; course: string; file?: string;
  };
  if (!cohort || !course) throw new Error("cohort와 course는 필수입니다.");

  const result = await issuerFetch(
    ctx,
    `/admin/chalk/cohorts/${encodeURIComponent(cohort)}/courses/${encodeURIComponent(course)}/plan?file=${encodeURIComponent(file)}`,
  ) as { html?: string; sha256?: string; knowledge_version?: number; ref_kind?: string; ref?: string };

  if (ctx.cwd && result.html) {
    const filePath = workingCopyPath(ctx.cwd, course, file);
    const dirty = await hasLocalChanges(filePath, result.html);
    if (dirty) {
      const ok = await ctx.requestConfirmation?.(
        `chalk/${course}/지도안.html에 저장되지 않은 변경이 있습니다. 서버 원문으로 덮어씁니까?`,
      );
      if (ok === false) {
        return { ...result, local_file: filePath, overwrite_skipped: true };
      }
    }
    await nodeFs.mkdir(nodePath.dirname(filePath), { recursive: true });
    await nodeFs.writeFile(filePath, result.html, "utf-8");
    return { ...result, local_file: filePath };
  }

  return result;
}

// chalk_save_plan — PUT /admin/chalk/cohorts/:cohort/courses/:course/plan
// 작업 사본 파일을 읽어 서버 초안에 저장한다. revision 충돌 시 "다시 열기"를 안내한다.
export const CHALK_SAVE_PLAN_DEF: ChalkToolDefinition = {
  name: "chalk_save_plan",
  description:
    "chalk/<course>/지도안.html을 읽어 서버 초안에 저장합니다. 저장 응답에 검사 결과(findings)가 포함됩니다. revision 충돌 시 chalk_open_course로 다시 열도록 안내합니다.",
  inputSchema: schema(
    {
      cohort: { ...str, description: "코호트 ID" },
      course: { ...str, description: "강의 ID" },
      file: { type: "string", enum: ["lesson", "ops"], description: "파일 종류 (기본: lesson)" },
      knowledge_version: { type: "number", description: "초안에 쓴 지식 버전 (필수)" },
      expected_revision: { type: "number", description: "현재 초안 revision (충돌 방지)" },
      request_id: { ...str, description: "멱등 키 (UUID)" },
    },
    ["cohort", "course", "knowledge_version", "expected_revision", "request_id"],
  ),
};

export async function execSavePlan(
  ctx: ChalkToolContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { cohort, course, file = "lesson", knowledge_version, expected_revision, request_id } =
    input as {
      cohort: string; course: string; file?: string;
      knowledge_version: number; expected_revision: number; request_id: string;
    };
  if (!cohort || !course) throw new Error("cohort와 course는 필수입니다.");
  if (!ctx.cwd) throw new Error("작업 폴더(cwd)가 설정되지 않았습니다.");

  const filePath = workingCopyPath(ctx.cwd, course, file);

  // chalk/<course>/ 안의 파일만 허용 (evaluateSdkToolUse workspace_root 경계와 같은 원칙)
  const chalkRoot = nodePath.resolve(ctx.cwd, "chalk", course);
  const resolved = nodePath.resolve(filePath);
  if (!resolved.startsWith(chalkRoot + nodePath.sep) && resolved !== chalkRoot) {
    throw new Error("chalk 작업 폴더 밖의 파일은 저장할 수 없습니다.");
  }

  let html: string;
  try {
    html = await nodeFs.readFile(filePath, "utf-8");
  } catch {
    throw new Error(`작업 사본을 찾을 수 없습니다: ${filePath}. chalk_open_course 또는 chalk_generator_brief를 먼저 실행하세요.`);
  }

  try {
    return await issuerFetch(
      ctx,
      `/admin/chalk/cohorts/${encodeURIComponent(cohort)}/courses/${encodeURIComponent(course)}/plan`,
      { method: "PUT", body: { file, html, knowledge_version, expected_revision, request_id } },
    );
  } catch (err) {
    if (err instanceof IssuerHttpError && err.status === 409) {
      const b = err.body as { error?: string } | null;
      const msg = b?.error ?? "";
      if (msg === "knowledge version not found") {
        return { error: "knowledge_version_not_found", message: "지식 버전을 찾을 수 없습니다. chalk_get_knowledge로 유효한 버전을 확인하세요." };
      }
      // revision 충돌 (revision conflict; reload before saving) 또는 기타 409
      return { error: "revision_conflict", message: "다른 곳에서 저장됐습니다. chalk_open_course로 최신 버전을 다시 열고 변경을 다시 적용하세요." };
    }
    throw err;
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
