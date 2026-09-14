import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceTools } from "../src/localRuntime/tools.ts";
import { localRuntimeConfig } from "../src/localRuntime/index.ts";
import { startToolServer } from "../src/localRuntime/toolServer.mjs";
import { subscriptionEnv } from "../src/localRuntime/process.mjs";
const root = await mkdtemp(join(tmpdir(), "studio-local-test-"));
try {
  const cwd = join(root, "work");
  await (await import("node:fs/promises")).mkdir(cwd);
  const profile = {
    sdk_tools: { read: true, write: true },
    tools: { web_search: false },
  };
  const ctrl = new AbortController();
  let approved = false,
    asks = 0;
  const tools = workspaceTools({
    cwd,
    profile,
    signal: ctrl.signal,
    approve: async () => {
      asks++;
      return approved;
    },
  });
  await assert.rejects(
    tools.call("Write", { file_path: "a.txt", content: "first" }),
    /허용/,
  );
  approved = true;
  await tools.call("Write", { file_path: "a.txt", content: "first" });
  assert.equal(await tools.call("Read", { file_path: "a.txt" }), "first");
  await tools.call("Edit", {
    file_path: "a.txt",
    old_string: "first",
    new_string: "second",
  });
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "second");
  await assert.rejects(
    tools.call("Edit", {
      file_path: "a.txt",
      old_string: "missing",
      new_string: "x",
    }),
    /일치/,
  );
  const before = asks;
  await assert.rejects(
    tools.call("Write", { file_path: "../escape.txt", content: "x" }),
    /밖/,
  );
  await writeFile(join(root, "private.txt"), "private");
  await symlink(join(root, "private.txt"), join(cwd, "link"));
  await assert.rejects(tools.call("Read", { file_path: "link" }), /밖/);
  assert.equal(asks, before);
  await assert.rejects(
    tools.call("Bash", { file_path: "a", command: "echo no" }),
    /없는/,
  );
  const denied = workspaceTools({
    cwd,
    profile: { sdk_tools: {} },
    signal: ctrl.signal,
    approve: async () => true,
  });
  assert.equal(denied.definitions.length, 0);
  await assert.rejects(denied.call("Read", { file_path: "a.txt" }), /없는/);
  const env = {
    HPS_DEV_RUNTIME: "1",
    HPS_DEV_PROVIDER: "claude",
    HPS_DEV_EXECUTABLE: "/cli/claude",
    HPS_DEV_MODEL: "sonnet",
  };
  assert.equal(
    localRuntimeConfig("HypeProof Studio", "http://127.0.0.1:8787/v1", env),
    null,
  );
  assert.equal(
    localRuntimeConfig("HypeProof Studio Dev", "http://127.0.0.1:8787/v1", {}),
    null,
  );
  assert.throws(
    () =>
      localRuntimeConfig(
        "HypeProof Studio Dev",
        "https://api.hypeproof-ai.xyz/v1",
        env,
      ),
    /로컬/,
  );
  assert.equal(
    localRuntimeConfig("HypeProof Studio Dev", "http://127.0.0.1:8787/v1", env)
      .provider,
    "claude",
  );
  assert.deepEqual(
    subscriptionEnv({
      HOME: "/home",
      PATH: "/bin",
      ANTHROPIC_API_KEY: "secret",
      ANTHROPIC_BASE_URL: "remote",
      CLAUDE_CODE_OAUTH_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
      HPS_WORKSHOP_TOKEN: "secret",
    }),
    { HOME: "/home", PATH: "/bin" },
  );
  const server = await startToolServer(
    tools.definitions,
    tools.call,
    ctrl.signal,
  );
  try {
    assert.equal(
      (await fetch(server.url, { method: "POST", body: "{}" })).status,
      401,
    );
    const invoke = async (method, params) => {
      const r = await fetch(server.url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + server.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return r.json();
    };
    assert.equal((await invoke("tools/list", {})).result.tools.length, 3);
    assert.equal(
      (
        await invoke("tools/call", {
          name: "Read",
          arguments: { file_path: "a.txt" },
        })
      ).result.content[0].text,
      "second",
    );
    assert.equal(
      (
        await invoke("tools/call", {
          name: "Write",
          arguments: { file_path: "../escape.txt", content: "x" },
        })
      ).result.isError,
      true,
    );
  } finally {
    server.close();
  }
  const pendingAbort = new AbortController();
  let releaseApproval, enteredApproval;
  const entered = new Promise((resolve) => (enteredApproval = resolve));
  const pendingTools = workspaceTools({
    cwd,
    profile,
    signal: pendingAbort.signal,
    approve: () => {
      enteredApproval();
      return new Promise((resolve) => (releaseApproval = resolve));
    },
  });
  const lateWrite = pendingTools.call("Write", {
    file_path: "cancelled.txt",
    content: "must not be written",
  });
  await entered;
  pendingAbort.abort();
  releaseApproval(true);
  await assert.rejects(lateWrite, /중지/);
  await assert.rejects(readFile(join(cwd, "cancelled.txt")), /ENOENT/);
  ctrl.abort();
  await assert.rejects(tools.call("Read", { file_path: "a.txt" }), /중지/);
  console.log(
    "PASS local runtime: approval, actual write/edit/read, policy denial, traversal/symlink, official-app isolation, credential scrubbing, authenticated MCP, cancellation",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
