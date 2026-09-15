import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ResolvedProfile } from "../protocol";
import {
  evaluateSdkToolUse,
  permittedToolsFor,
  type CoachToolAction,
  type SdkActivity,
} from "../sdkCoachHelpers.ts";

const LIMIT = 200_000;
const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string" };
const DEFINITIONS = [
  {
    name: "Read",
    description: "Read a UTF-8 file inside the current Studio workspace.",
    inputSchema: schema({ file_path: string }, ["file_path"]),
  },
  {
    name: "Write",
    description:
      "Create or replace a UTF-8 file inside the workspace after Studio approval.",
    inputSchema: schema({ file_path: string, content: string }, [
      "file_path",
      "content",
    ]),
  },
  {
    name: "Edit",
    description:
      "Replace exactly one matching string in a workspace file after Studio approval.",
    inputSchema: schema(
      { file_path: string, old_string: string, new_string: string },
      ["file_path", "old_string", "new_string"],
    ),
  },
];

async function canonical(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const parent = path.dirname(target);
    if (parent === target) throw e;
    return path.join(await canonical(parent), path.basename(target));
  }
}

export function workspaceTools(args: {
  cwd: string;
  profile: ResolvedProfile;
  signal: AbortSignal;
  approve: (
    a: CoachToolAction,
  ) => Promise<boolean | { approved: boolean; actor: "user" | "policy" }>;
  activity?: (a: SdkActivity) => void;
}) {
  const permitted = permittedToolsFor(args.profile);
  const definitions = DEFINITIONS.filter((t) => permitted.includes(t.name));
  let queue: Promise<unknown> = Promise.resolve();
  async function execute(name: string, raw: unknown): Promise<string> {
    const id = randomUUID();
    const input = raw as Record<string, unknown>;
    if (
      !input ||
      typeof input.file_path !== "string" ||
      !definitions.some((t) => t.name === name)
    )
      throw Error("이 수업에서 사용할 수 없는 파일 도구입니다.");
    const file = path.resolve(args.cwd, input.file_path);
    const root = await canonical(path.resolve(args.cwd));
    const gate = async () => {
      if (args.signal.aborted) throw Error("요청이 중지되었습니다.");
      const actual = await canonical(file);
      const verdict = evaluateSdkToolUse({
        toolName: name,
        input: { ...input, file_path: actual },
        permittedTools: permitted,
        workspaceRoot: root,
      });
      if (verdict.decision === "deny") throw Error(verdict.friendly);
      return actual;
    };
    const actual = await gate();
    args.activity?.({
      kind: "tool_use",
      id,
      name,
      input: { ...input, file_path: actual },
    });
    try {
      if (name !== "Read") {
        const approval = await args.approve({
          toolName: name,
          input: { ...input, file_path: actual },
        });
        const allowed =
          typeof approval === "boolean" ? approval : approval.approved;
        args.activity?.({
          kind: "approval",
          id,
          name,
          input,
          allowed,
          actor: typeof approval === "boolean" ? "user" : approval.actor,
        });
        if (!allowed) throw Error("사용자가 파일 변경을 허용하지 않았습니다.");
      }
      if ((await gate()) !== actual)
        throw Error("승인 중 파일 경로가 바뀌었습니다. 다시 요청하세요.");
      let result: string;
      if (name === "Read") {
        if ((await fs.stat(actual)).size > LIMIT)
          throw Error("파일이 너무 큽니다. 작은 파일로 나누세요.");
        result = await fs.readFile(actual, "utf8");
      } else {
        let content = input.content;
        if (name === "Edit") {
          if (
            typeof input.old_string !== "string" ||
            !input.old_string ||
            typeof input.new_string !== "string"
          )
            throw Error("교체할 원문과 새 문장이 필요합니다.");
          if ((await fs.stat(actual)).size > LIMIT)
            throw Error("파일이 너무 큽니다.");
          const before = await fs.readFile(actual, "utf8");
          if (before.split(input.old_string).length !== 2)
            throw Error(
              "원문이 정확히 한 번 일치해야 합니다. 파일을 다시 읽으세요.",
            );
          content = before.replace(
            input.old_string,
            () => input.new_string as string,
          );
        }
        if (typeof content !== "string" || Buffer.byteLength(content) > LIMIT)
          throw Error("파일 내용이 없거나 너무 큽니다.");
        await fs.mkdir(path.dirname(actual), { recursive: true });
        if ((await gate()) !== actual) throw Error("파일 경로가 바뀌었습니다.");
        await fs.writeFile(actual, content, "utf8");
        result = "저장 완료: " + path.relative(root, actual);
      }
      args.activity?.({ kind: "tool_result", id, isError: false });
      return result;
    } catch (e) {
      args.activity?.({
        kind: "tool_result",
        id,
        isError: true,
        reason: (e as Error).message,
      });
      throw e;
    }
  }
  return {
    definitions,
    call(name: string, input: unknown) {
      const next = queue.then(() => execute(name, input));
      queue = next.catch(() => {});
      return next;
    },
  };
}
