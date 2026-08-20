// Agent SDK tool surface — WITHOUT this the harness measures a class that
// does not exist.
//
// Measured 2026-08-19, 1-person control with NO tools: the "바꿔줘" build turn
// produced 165 output tokens. In production that same turn makes the coach
// Write a whole index.html — the real kids-quest skeletons are 11.8-14.0 KB
// (worker/src/skeletons/kids-quest/*.html), i.e. thousands of output tokens.
// A tool-less harness therefore understates output tokens ~25x on exactly the
// turns that produced the 보아치과 p99 of 211s.
//
// Tool names are the Agent SDK's, confirmed in
// extensions/hypeproof-chat/src/sdkCoachHelpers.ts:112,261
// (SDK_WRITE_TOOL_NAMES = ["Write","Edit"]) — CamelCase, per
// isClassifiedSdkToolName. The cohort grants sdk_tools:{read,write}
// (sk-biopharm-kids-*.ts), so Read + Write + Edit is the real grant.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKELETON_DIR = join(HERE, "../../worker/src/skeletons/kids-quest");

/** Guest → the skeleton the prompt's table assigns them. */
const GUEST_SKELETON = {
  초코: "catcher.html", 나비: "runner.html", 붕붕: "collect.html",
  뽀로: "stack.html", 찍찍: "run.html", 햄찌: "whack.html",
  앵무: "memory.html", 도토: "jump.html", 라쿤: "sort.html",
};

const cache = new Map();

/**
 * The real skeleton bytes, used as the synthetic Read result. Not invented —
 * these are the same files the worker serves, so the input-token cost of a
 * Read is the production cost.
 */
export function skeletonFor(guestName) {
  const file = GUEST_SKELETON[guestName] ?? "catcher.html";
  if (!cache.has(file)) {
    cache.set(file, readFileSync(join(SKELETON_DIR, file), "utf8"));
  }
  return cache.get(file);
}

/**
 * Tool definitions in Anthropic Messages-API shape. Schemas match the Agent
 * SDK's built-ins so the model produces the same tool_use payloads.
 */
export function toolDefs() {
  return [
    {
      name: "Read",
      description: "Read a file from the local filesystem. Returns the file contents with line numbers.",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file to read" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["file_path"],
      },
    },
    {
      name: "Write",
      description: "Write a file to the local filesystem, overwriting if it exists. Read the file first if it already exists.",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file to write" },
          content: { type: "string", description: "The full contents to write" },
        },
        required: ["file_path", "content"],
      },
    },
    {
      name: "Edit",
      description: "Perform an exact string replacement in a file.",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
  ];
}

/**
 * Synthetic tool_result for a tool_use block. Mirrors what the Studio host
 * would send back after `canUseTool` approval — we always approve, because a
 * denial path would short-circuit exactly the expensive turn we are measuring.
 *
 * `state` carries the virtual workspace so a Read after a Write returns what
 * the coach actually wrote (otherwise the second build turn would re-Read the
 * pristine skeleton and the context would stop growing the way it does in a
 * real session).
 */
export function toolResultFor(block, state) {
  const name = block.name;
  const input = block.input ?? {};
  const id = block.id;

  if (name === "Read") {
    const content = state.files[input.file_path] ?? state.files["index.html"] ?? state.skeleton;
    // The Read tool returns cat -n style, which is what the model was trained
    // to expect and what makes the token count realistic.
    const numbered = content
      .split("\n")
      .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
      .join("\n");
    return { type: "tool_result", tool_use_id: id, content: numbered };
  }

  if (name === "Write") {
    if (typeof input.content === "string" && input.file_path) {
      state.files[input.file_path] = input.content;
      state.files["index.html"] = input.content;
      state.writes++;
      state.lastWriteChars = input.content.length;
    }
    return {
      type: "tool_result",
      tool_use_id: id,
      content: `File created successfully at: ${input.file_path ?? "index.html"}`,
    };
  }

  if (name === "Edit") {
    const path = input.file_path ?? "index.html";
    const cur = state.files[path] ?? state.skeleton;
    if (typeof input.old_string === "string" && cur.includes(input.old_string)) {
      const next = input.replace_all
        ? cur.split(input.old_string).join(input.new_string ?? "")
        : cur.replace(input.old_string, input.new_string ?? "");
      state.files[path] = next;
      state.files["index.html"] = next;
      state.writes++;
      return { type: "tool_result", tool_use_id: id, content: `The file ${path} has been updated.` };
    }
    return {
      type: "tool_result", tool_use_id: id, is_error: true,
      content: `String to replace not found in file.`,
    };
  }

  return {
    type: "tool_result", tool_use_id: id, is_error: true,
    content: `Tool ${name} is not available in this cohort.`,
  };
}

export function newWorkspaceState(guestName, workspaceRoot = "~/HypeProofQuests") {
  const skeleton = skeletonFor(guestName);
  return {
    skeleton,
    root: workspaceRoot,
    files: { "index.html": skeleton, [`${workspaceRoot}/index.html`]: skeleton },
    writes: 0,
    lastWriteChars: 0,
  };
}
