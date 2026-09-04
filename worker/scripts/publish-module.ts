#!/usr/bin/env -S node --experimental-strip-types
// Curriculum module publisher — the Module layer's distribution tool (dag task
// H; docs/plan/vessel-and-modules.md §1 "Module is not a train. It is data, not
// code — distribution, not deployment.")
//
// A curriculum change goes: edit the .md → `publish` (writes an immutable
// version to KV) → `pin` (activates it). No code review, no worker deploy, no
// build. Rollback = `pin` the previous version. Because it never touches the
// worker artifact it is exempt from the live-class deploy freeze (task D).
//
//   npm run module -- publish <profile_id> <prompt.md> [--version m2026.09.04-1]
//                              [--notes "…"] [--by <name>] [--pin] [--force] [--local]
//   npm run module -- pin      <profile_id> <version> [--by <name>] [--local]
//   npm run module -- unpin    <profile_id> [--local]          # back to the compiled text
//   npm run module -- status   <profile_id> [--local]          # what is pinned, is it servable
//   npm run module -- validate <profile_id> <prompt.md>        # offline, no KV
//
// --local targets `wrangler dev`'s local KV; the default is the production
// namespace (needs wrangler auth). Every KV access is `npx wrangler kv key …`
// against the HPS_KV binding — no HTTP route, no new secret.
//
// The document it writes and the check it runs are the WORKER's own
// (src/lib/modules.ts makeModuleDoc / validateModuleDoc). If the worker would
// reject it, this tool refuses to write it; if the worker would refuse to pin
// it, this tool refuses to pin it. One format, one validator, one drift lock
// (test/module-distribution.test.mjs).
//
// Policy: versions are IMMUTABLE. `publish` refuses to overwrite an existing
// version unless --force — a republish under the same name would make the
// worker's per-isolate memo and prompt cache disagree about what a version is.

import { registerHooks } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z0-9]+$/i.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        try {
          return nextResolve(specifier, context);
        } catch {
          return nextResolve(`${specifier}/index.ts`, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".md") || url.endsWith(".html")) {
      const text = readFileSync(fileURLToPath(url), "utf8");
      return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(text)};` };
    }
    return nextLoad(url, context);
  },
});

const modules = await import("../src/lib/modules.ts");
const { getProfile } = await import("../src/profiles/index.ts");
const {
  makeModuleDoc,
  validateModuleDoc,
  validatePin,
  moduleDocKey,
  modulePinKey,
  isModuleVersion,
  MODULE_VERSION_RE,
} = modules;
type ModuleDoc = import("../src/lib/modules.ts").ModuleDoc;
type ModulePin = import("../src/lib/modules.ts").ModulePin;

// ─── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flags = new Map<string, string | true>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) {
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--") && ["version", "notes", "by"].includes(name)) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  } else {
    positional.push(a);
  }
}
const [cmd, profileId, arg3] = positional;
const LOCAL = flags.get("local") === true;
const KIND = "curriculum" as const;

function die(msg: string): never {
  console.error(`publish-module: ${msg}`);
  process.exit(1);
}
function usage(): never {
  console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 20).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(2);
}

// ─── wrangler kv wrapper ─────────────────────────────────────────────────────

function wranglerKv(args: string[], opts: { allowFail?: boolean } = {}): string {
  // HPS_KV declares both `id` and `preview_id` (wrangler.toml), so wrangler
  // insists on an explicit choice. `wrangler dev` reads the PREVIEW namespace
  // in local mode, so --local targets that; production is the real namespace.
  const full = [
    "wrangler", "kv", "key", ...args, "--binding", "HPS_KV",
    ...(LOCAL ? ["--local", "--preview"] : ["--remote", "--preview", "false"]),
  ];
  try {
    return execFileSync("npx", full, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (opts.allowFail) return "";
    const e = err as { stderr?: string; message?: string };
    die(`wrangler failed: npx ${full.join(" ")}\n${e.stderr ?? e.message ?? ""}`);
  }
}

function kvGet(key: string): unknown | null {
  const out = wranglerKv(["get", key], { allowFail: true });
  // Observed (wrangler 4.118, --local and --remote): a missing key prints
  // "Value not found" on stdout and exits 0. It is not an error and not JSON.
  if (!out.trim() || out.trim() === "Value not found") return null;
  try {
    return JSON.parse(out);
  } catch {
    return { __unparseable: true, raw: out.slice(0, 200) };
  }
}

function kvPut(key: string, value: unknown): void {
  const dir = mkdtempSync(join(tmpdir(), "hps-module-"));
  const file = join(dir, "value.json");
  try {
    writeFileSync(file, JSON.stringify(value));
    wranglerKv(["put", key, "--path", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function kvDelete(key: string): void {
  wranglerKv(["delete", key]);
}

function kvListVersions(pid: string): string[] {
  const prefix = moduleDocKey(KIND, pid, "");
  const out = wranglerKv(["list", "--prefix", prefix], { allowFail: true });
  if (!out.trim()) return [];
  let parsed: Array<{ name: string }>;
  try {
    parsed = JSON.parse(out);
  } catch {
    return [];
  }
  return parsed.map((k) => k.name.slice(prefix.length)).filter(isModuleVersion).sort();
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function requireProfile(pid: string | undefined) {
  if (!pid) usage();
  const p = getProfile(pid);
  if (!p) die(`unknown profile ${JSON.stringify(pid)} — it must exist in the compiled registry (profiles/index.ts)`);
  return p;
}

function todayTag(): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `m${d.getFullYear()}.${p2(d.getMonth() + 1)}.${p2(d.getDate())}`;
}

function nextVersion(pid: string): string {
  const day = todayTag();
  const n = kvListVersions(pid)
    .filter((v) => v.startsWith(day + "-"))
    .map((v) => Number(v.slice(day.length + 1)))
    .reduce((a, b) => Math.max(a, b), 0);
  return `${day}-${n + 1}`;
}

async function buildDoc(pid: string, file: string, version: string): Promise<ModuleDoc> {
  const text = readFileSync(file, "utf8");
  const notes = typeof flags.get("notes") === "string" ? (flags.get("notes") as string) : undefined;
  const doc = await makeModuleDoc({ kind: KIND, profileId: pid, version, content: { system_prompt: text }, notes });
  const v = await validateModuleDoc(doc, { kind: KIND, profileId: pid, version });
  if (!v.ok) die(`the worker would reject this document: ${v.reason}`);
  return doc;
}

async function checkServable(pid: string, version: string): Promise<{ ok: true; doc: ModuleDoc } | { ok: false; reason: string }> {
  const raw = kvGet(moduleDocKey(KIND, pid, version));
  if (raw == null) return { ok: false, reason: "no document at this key" };
  return validateModuleDoc(raw, { kind: KIND, profileId: pid, version });
}

function readPin(pid: string): ModulePin | null {
  const raw = kvGet(modulePinKey(KIND, pid));
  if (raw == null) return null;
  const v = validatePin(raw);
  if (!v.ok) die(`current pin is malformed (${v.reason}) — fix with \`pin\` or \`unpin\``);
  return v.pin;
}

async function doPin(pid: string, version: string): Promise<void> {
  if (!isModuleVersion(version)) die(`version must match ${MODULE_VERSION_RE}`);
  const s = await checkServable(pid, version);
  if (!s.ok) die(`refusing to pin ${version}: the worker could not serve it (${s.reason})`);
  const current = readPin(pid);
  if (current?.version === version) {
    console.log(`already pinned: ${pid} → ${version}`);
    return;
  }
  const pin: ModulePin = {
    version,
    previous: current?.version ?? null,
    pinned_at: new Date().toISOString(),
    by: typeof flags.get("by") === "string" ? (flags.get("by") as string) : process.env.USER ?? undefined,
  };
  kvPut(modulePinKey(KIND, pid), pin);
  console.log(`pinned ${pid} → ${version}${pin.previous ? ` (previous: ${pin.previous})` : ""} [${LOCAL ? "local" : "remote"}]`);
  console.log("Reaches every PoP within ~1–2 min (KV propagation + the worker's 30 s pin memo). No deploy.");
}

// ─── commands ────────────────────────────────────────────────────────────────

switch (cmd) {
  case "validate": {
    const p = requireProfile(profileId);
    if (!arg3) usage();
    const version = typeof flags.get("version") === "string" ? (flags.get("version") as string) : `${todayTag()}-1`;
    const doc = await buildDoc(p.id, arg3, version);
    const chars = (doc.content as { system_prompt: string }).system_prompt.length;
    console.log(`OK — ${p.id} ${version}: ${chars} chars, sha256 ${doc.sha256.slice(0, 12)}…`);
    break;
  }

  case "publish": {
    const p = requireProfile(profileId);
    if (!arg3) usage();
    const version = typeof flags.get("version") === "string" ? (flags.get("version") as string) : nextVersion(p.id);
    if (!isModuleVersion(version)) die(`--version must match ${MODULE_VERSION_RE} (e.g. ${todayTag()}-1)`);
    const key = moduleDocKey(KIND, p.id, version);
    if (kvGet(key) != null && flags.get("force") !== true) {
      die(`${version} already exists for ${p.id}. Versions are immutable — pick a new version (omit --version to auto-number), or --force to overwrite anyway.`);
    }
    const doc = await buildDoc(p.id, arg3, version);
    kvPut(key, doc);
    console.log(`published ${p.id} ${version} (${(doc.content as { system_prompt: string }).system_prompt.length} chars, sha256 ${doc.sha256.slice(0, 12)}…) [${LOCAL ? "local" : "remote"}]`);
    if (flags.get("pin") === true) await doPin(p.id, version);
    else console.log(`not active yet — activate with: npm run module -- pin ${p.id} ${version}${LOCAL ? " --local" : ""}`);
    break;
  }

  case "pin": {
    const p = requireProfile(profileId);
    if (!arg3) usage();
    await doPin(p.id, arg3);
    break;
  }

  case "unpin": {
    const p = requireProfile(profileId);
    const cur = readPin(p.id);
    if (!cur) {
      console.log(`${p.id} is not pinned (compiled text is served)`);
      break;
    }
    kvDelete(modulePinKey(KIND, p.id));
    console.log(`unpinned ${p.id} (was ${cur.version}) — the compiled text is served again`);
    break;
  }

  case "status": {
    const p = requireProfile(profileId);
    const cur = readPin(p.id);
    const versions = kvListVersions(p.id);
    console.log(`profile:   ${p.id} [${LOCAL ? "local" : "remote"}]`);
    console.log(`versions:  ${versions.length ? versions.join(", ") : "(none published)"}`);
    if (!cur) {
      console.log("pinned:    (none) → the worker serves the compiled text, version compiled:<hash>");
      break;
    }
    console.log(`pinned:    ${cur.version}${cur.previous ? ` (previous ${cur.previous})` : ""} at ${cur.pinned_at}${cur.by ? ` by ${cur.by}` : ""}`);
    const s = await checkServable(p.id, cur.version);
    if (s.ok) {
      console.log(`servable:  yes — ${(s.doc.content as { system_prompt: string }).system_prompt.length} chars, sha256 ${s.doc.sha256.slice(0, 12)}…${s.doc.notes ? `, notes: ${s.doc.notes}` : ""}`);
    } else {
      console.log(`servable:  NO — ${s.reason}`);
      const prev = cur.previous ? await checkServable(p.id, cur.previous) : null;
      console.log(
        prev?.ok
          ? `           the worker is serving previous ${cur.previous} (loudly). Fix: publish a good version and re-pin.`
          : `           the worker is serving the COMPILED text (loudly). Fix: publish a good version and re-pin.`,
      );
      process.exitCode = 1;
    }
    break;
  }

  default:
    usage();
}
