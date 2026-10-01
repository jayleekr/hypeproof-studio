// The published file set of a test version (cr-publish #1393; recon R4; CR-17, CR-T17).
//
// Not the workspace: the entry HTML and every file it reaches through static references
// (`artifactVersionFor`, the same walk that names the version a result or a verification was
// taken against), plus the files the student adds to an explicit manifest in the publish
// panel. Never a dot-file or dot-directory, `node_modules`, or anything outside the root,
// whatever the manifest says. Every file is checked on disk when the set is built and again
// just before it is read for upload: a symlink, or a real path outside the root's real path,
// refuses the publish. So does a file over the size cap, a set past the file or byte cap,
// or a hit of the publish scan (`publish-scan.ts`, the scanner the Worker re-runs on receipt).
// A refusal names the file; nothing is uploaded.
//
// With no manifest additions the set's id equals `artifactVersionFor(...).id`, so the version
// that was verified is the version that is served (CR-81). vscode-free (Node fs only).

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { digestOf } from "../../../worker/src/lib/measurement-core/local-record.ts";
import { publishPathProblem } from "../../../worker/src/lib/curriculum/venture.ts";
import { scanFile, type ScanContext, type ScanHit } from "../../../worker/src/lib/curriculum/publish-scan.ts";
import { ArtifactSetError, artifactVersionFor } from "./artifactVersion.ts";
import { resolveWithinRoot } from "./liveServerHelpers.ts";

/** Mirrors the Worker's PUBLISH_LIMITS (worker/src/routes/curriculum.ts); the Worker re-checks. */
export const PUBLISH_SET_LIMITS = { maxFiles: 200, maxFileBytes: 5 * 1024 * 1024, maxSetBytes: 20 * 1024 * 1024 } as const;

export interface PublishFile {
  path: string;
  sha256: string;
  bytes: number;
  data: Buffer;
}

export interface PublishSet {
  /** R4 digest of the sorted `[{path, sha256, bytes}]`. */
  id: string;
  entry: string;
  files: PublishFile[];
  manifest_added: string[];
}

export type PublishSetCode =
  | "outside_root"
  | "excluded_path"
  | "invalid_path"
  | "symlink"
  | "realpath_outside_root"
  | "not_found"
  | "too_many_files"
  | "file_too_large"
  | "set_too_large"
  | "changed_during_read"
  | "secret_found";

export interface PublishSetRefusal {
  code: PublishSetCode;
  file?: string;
  hits?: ScanHit[];
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** lstat + realpath of one file of the set: a refusal, or its size. */
async function checkOnDisk(root: string, realRoot: string, rel: string): Promise<PublishSetRefusal | { size: number }> {
  const abs = resolveWithinRoot(root, "/" + rel);
  if (!abs) return { code: "outside_root", file: rel };
  const st = await fsp.lstat(abs).catch(() => null);
  if (!st) return { code: "not_found", file: rel };
  if (st.isSymbolicLink()) return { code: "symlink", file: rel };
  if (!st.isFile()) return { code: "not_found", file: rel };
  const real = await fsp.realpath(abs);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { code: "realpath_outside_root", file: rel };
  if (st.size > PUBLISH_SET_LIMITS.maxFileBytes) return { code: "file_too_large", file: rel };
  return { size: st.size };
}

/**
 * Build the set for the entry page at `entryUrlPath` (a URL path under the served root) plus
 * the manifest. `scan` names the Project and its test origin for the token rule (R4).
 */
export async function buildPublishSet(
  root: string,
  entryUrlPath: string,
  manifest: readonly string[],
  scan: ScanContext,
): Promise<{ ok: true; set: PublishSet } | { ok: false; refusal: PublishSetRefusal }> {
  let version;
  try {
    version = await artifactVersionFor(root, entryUrlPath, { maxFiles: PUBLISH_SET_LIMITS.maxFiles, maxFileBytes: PUBLISH_SET_LIMITS.maxFileBytes });
  } catch (e) {
    if (e instanceof ArtifactSetError) return { ok: false, refusal: { code: e.code, file: e.file } };
    throw e;
  }
  if (version.partial) return { ok: false, refusal: { code: "too_many_files" } };
  // A referenced file the version walk could only list (a symlink, an out-of-root real path,
  // an oversize file) refuses the publish: a public version must be exactly what was hashed.
  for (const f of version.files) {
    if (f.sha256 === null) return { ok: false, refusal: { code: f.skipped === "too_large" ? "file_too_large" : (f.skipped as PublishSetCode), file: f.path } };
  }
  const realRoot = await fsp.realpath(root);
  const listed = new Map(version.files.map((f) => [f.path, f.sha256 as string]));
  const added: string[] = [];
  for (const m of manifest) {
    const rel = m.replace(/^\/+/, "");
    const problem = publishPathProblem(rel);
    if (problem) return { ok: false, refusal: { code: problem as PublishSetCode, file: m } };
    if (listed.has(rel) || added.includes(rel)) continue;
    const on = await checkOnDisk(root, realRoot, rel);
    if ("code" in on) return { ok: false, refusal: on };
    added.push(rel);
  }
  const all = [...listed.keys(), ...added];
  if (all.length > PUBLISH_SET_LIMITS.maxFiles) return { ok: false, refusal: { code: "too_many_files" } };
  const files: PublishFile[] = [];
  let total = 0;
  for (const rel of all) {
    // Again just before reading: the coach has a shell and can swap a file for a symlink.
    const on = await checkOnDisk(root, realRoot, rel);
    if ("code" in on) return { ok: false, refusal: on };
    const data = await fsp.readFile(resolveWithinRoot(root, "/" + rel)!);
    const digest = sha256(data);
    if (listed.has(rel) && listed.get(rel) !== digest) return { ok: false, refusal: { code: "changed_during_read", file: rel } };
    total += data.length;
    if (total > PUBLISH_SET_LIMITS.maxSetBytes) return { ok: false, refusal: { code: "set_too_large" } };
    files.push({ path: rel, sha256: digest, bytes: data.length, data });
  }
  // The publish scan, before anything leaves the machine.
  const hits = files.flatMap((f) => scanFile(f.path, f.data.toString("utf8"), scan));
  if (hits.length) return { ok: false, refusal: { code: "secret_found", file: hits[0]!.file, hits } };
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const id = await digestOf(files.map(({ path: p, sha256: s, bytes }) => ({ path: p, sha256: s, bytes })));
  return { ok: true, set: { id, entry: version.entry, files, manifest_added: added } };
}

/** Student-facing words for a refused set. Names the file. */
export function publishSetRefusalText(r: PublishSetRefusal): string {
  const f = r.file ? `${r.file}: ` : "";
  switch (r.code) {
    case "secret_found":
      return `${f}비밀값처럼 보이는 내용이 있어 공개하지 않았어요. 아래 줄을 고친 뒤 다시 공개하세요.`;
    case "symlink":
    case "realpath_outside_root":
      return `${f}작업 폴더 밖을 가리키는 바로가기(심볼릭 링크)라 공개하지 않았어요.`;
    case "excluded_path":
      return `${f}점(.)으로 시작하는 파일이나 node_modules 는 공개하지 않아요.`;
    case "file_too_large":
      return `${f}파일이 너무 커요 (한 파일 5MB까지).`;
    case "set_too_large":
      return "공개할 파일을 모두 합치면 너무 커요 (20MB까지).";
    case "too_many_files":
      return "공개할 파일이 너무 많아요 (200개까지).";
    case "not_found":
      return `${f}파일을 찾지 못했어요.`;
    case "changed_during_read":
      return `${f}공개하는 동안 파일이 바뀌었어요. 다시 공개해 주세요.`;
    default:
      return `${f}작업 폴더 안의 파일만 공개할 수 있어요.`;
  }
}
