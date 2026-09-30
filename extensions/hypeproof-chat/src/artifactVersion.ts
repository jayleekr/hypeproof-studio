// Artifact version of the page a browser result was taken against (CR-10; recon R4).
//
// The version id is the sha256 of the canonical JSON of the sorted `[{path, sha256,
// bytes}]` list of the artifact's file set, computed with `digestOf` from the one
// measurement-core (`local-record.ts`), so the version a result names is the version
// cr-publish will serve. Each file's sha256 is the plain hex digest the `artifact`
// observation events already carry (AE-37 keeps binding single files).
//
// The set is NOT the workspace (R4): the entry HTML plus every file it reaches through
// static references (`src`, `href`, CSS `url()` / `@import`, JS `import`), resolved
// inside the served root. It never includes a dot-file, a dot-directory, `node_modules`
// or anything outside the root. Only the ENTRY can refuse the version (a symlink, a real
// path outside the root, too large). A referenced file that cannot be hashed is still
// listed, never read: a symlink or out-of-root real path as `{sha256: null, skipped}`,
// a file over the size cap as `{bytes, sha256: null, skipped: "too_large"}` so the version
// still moves when its size does. Past the file cap the walk stops and the version is
// marked `partial`. One large photo in a student's page must not make every browser
// result unusable. cr-publish adds the explicit manifest, the secret scan and the size
// caps on top of this; nothing here uploads anything.
//
// vscode-free (Node fs only) so the smokes run it on a temporary directory.

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { digestOf } from "../../../worker/src/lib/measurement-core/local-record.ts";
import { resolveWithinRoot } from "./liveServerHelpers.ts";
import type { ArtifactFileRef, ArtifactVersionRef } from "./experimentBrowser.ts";

export interface ArtifactSetLimits {
  maxFiles: number;
  maxFileBytes: number;
}

export const DEFAULT_ARTIFACT_SET_LIMITS: ArtifactSetLimits = { maxFiles: 200, maxFileBytes: 5 * 1024 * 1024 };

/** Refusals carry a code a caller can show next to the file it names. */
export type ArtifactSetCode = "outside_root" | "excluded_path" | "symlink" | "realpath_outside_root" | "not_found" | "too_many_files" | "file_too_large";

export class ArtifactSetError extends Error {
  readonly code: ArtifactSetCode;
  readonly file: string;
  constructor(code: ArtifactSetCode, file: string) {
    super(`${code}: ${file}`);
    this.name = "ArtifactSetError";
    this.code = code;
    this.file = file;
  }
}

const SKIP_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const REFERENCE_PATTERNS: Record<string, RegExp[]> = {
  html: [
    /\b(?:src|href|poster|data)\s*=\s*"([^"]*)"/gi,
    /\b(?:src|href|poster|data)\s*=\s*'([^']*)'/gi,
    /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
    /\bimport\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ],
  css: [/url\(\s*["']?([^"')]+)["']?\s*\)/gi, /@import\s+["']([^"']+)["']/gi],
  js: [
    /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ],
};

function kindOf(file: string): keyof typeof REFERENCE_PATTERNS | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".css") return "css";
  if (ext === ".js" || ext === ".mjs") return "js";
  return null;
}

/** Static references of one text file, as root-relative URL paths (no query or hash). */
export function staticReferences(text: string, fileRel: string): string[] {
  const kind = kindOf(fileRel);
  if (!kind) return [];
  const out = new Set<string>();
  const baseDir = path.posix.dirname("/" + fileRel.split(path.sep).join("/"));
  for (const re of REFERENCE_PATTERNS[kind]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const raw = (m[1] ?? "").trim();
      if (!raw || SKIP_SCHEME.test(raw)) continue;
      const clean = raw.split(/[?#]/)[0];
      if (!clean) continue;
      out.add(clean.startsWith("/") ? path.posix.normalize(clean) : path.posix.normalize(path.posix.join(baseDir, clean)));
    }
  }
  return [...out];
}

const isExcluded = (rel: string): boolean =>
  rel.split(/[\\/]/).some((seg) => seg.startsWith(".") || seg === "node_modules");

/**
 * The version of the artifact whose entry page is `entryUrlPath` (a URL path under the
 * served `root`, e.g. `/index.html` or `/`).
 */
export async function artifactVersionFor(
  root: string,
  entryUrlPath: string,
  limits: ArtifactSetLimits = DEFAULT_ARTIFACT_SET_LIMITS,
): Promise<ArtifactVersionRef> {
  const realRoot = await fsp.realpath(root);
  const files = new Map<string, ArtifactFileRef>();
  const queue: Array<{ urlPath: string; required: boolean }> = [{ urlPath: entryUrlPath, required: true }];
  let entry: string | null = null;
  let partial = false;
  while (queue.length) {
    const { urlPath, required } = queue.shift()!;
    let abs = resolveWithinRoot(root, urlPath);
    if (!abs) {
      if (required) throw new ArtifactSetError("outside_root", urlPath);
      continue;
    }
    let st = await fsp.lstat(abs).catch(() => null);
    if (st?.isDirectory()) {
      abs = path.join(abs, "index.html");
      st = await fsp.lstat(abs).catch(() => null);
    }
    const rel = path.relative(path.resolve(root), abs).split(path.sep).join("/");
    if (!st) {
      // A reference to a file that does not exist is a broken link, not part of the set.
      if (required) throw new ArtifactSetError("not_found", rel || urlPath);
      continue;
    }
    if (isExcluded(rel)) {
      if (required) throw new ArtifactSetError("excluded_path", rel);
      continue;
    }
    if (files.has(rel)) continue;
    if (st.isSymbolicLink()) {
      if (required) throw new ArtifactSetError("symlink", rel);
      files.set(rel, { path: rel, sha256: null, bytes: 0, skipped: "symlink" });
      continue;
    }
    if (!st.isFile()) continue;
    const real = await fsp.realpath(abs);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      if (required) throw new ArtifactSetError("realpath_outside_root", rel);
      files.set(rel, { path: rel, sha256: null, bytes: 0, skipped: "realpath_outside_root" });
      continue;
    }
    if (files.size >= limits.maxFiles) {
      // Stop following references; the set is marked partial instead of refused.
      partial = true;
      break;
    }
    if (st.size > limits.maxFileBytes) {
      if (required) throw new ArtifactSetError("file_too_large", rel);
      files.set(rel, { path: rel, sha256: null, bytes: st.size, skipped: "too_large" });
      continue;
    }
    const bytes = await fsp.readFile(abs);
    files.set(rel, { path: rel, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
    if (entry === null) entry = rel;
    for (const ref of staticReferences(bytes.toString("utf8"), rel)) queue.push({ urlPath: ref, required: false });
  }
  const list = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // `partial` is part of the digest: a capped set never shares an id with a complete one.
  const id = await digestOf(partial ? { files: list, partial: "too_many_files" } : list);
  return { id, entry: entry ?? "", files: list, ...(partial ? { partial: "too_many_files" as const } : {}) };
}
