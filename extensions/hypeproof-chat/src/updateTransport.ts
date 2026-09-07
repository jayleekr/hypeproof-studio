import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const RELEASES_API = "https://api.github.com/repos/jayleekr/hypeproof-studio-releases/releases/latest";
const RELEASE_PATH = "/jayleekr/hypeproof-studio-releases/releases/download/";

export function trustedUpdateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://github.com" && !url.username && !url.password &&
      url.pathname.startsWith(RELEASE_PATH) && !url.search && !url.hash;
  } catch { return false; }
}

export async function fetchLatestRelease(): Promise<unknown> {
  const response = await fetch(RELEASES_API, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Update check failed: HTTP ${response.status}`);
  return response.json();
}

/** A GitHub asset digest detects corruption; it is not a code-signing identity. */
export async function downloadVerifiedUpdate(
  asset: { downloadUrl: string; sizeBytes: number; digest?: string },
  destination: string,
  options: { idleTimeoutMs?: number; totalTimeoutMs?: number } = {},
): Promise<void> {
  if (!trustedUpdateUrl(asset.downloadUrl)) throw new Error("Untrusted update download URL");
  if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0 || asset.sizeBytes > 2 * 1024 ** 3) {
    throw new Error("Invalid update size");
  }
  if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? "")) throw new Error("Update SHA-256 digest is missing");

  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Update download timed out"));
  const total = setTimeout(abort, options.totalTimeoutMs ?? 10 * 60_000);
  let idle = setTimeout(abort, options.idleTimeoutMs ?? 60_000);
  let created = false;
  try {
    const response = await fetch(asset.downloadUrl, { redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Update download failed: HTTP ${response.status}`);
    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        clearTimeout(idle);
        idle = setTimeout(abort, options.idleTimeoutMs ?? 60_000);
        bytes += chunk.length;
        if (bytes > asset.sizeBytes) { callback(new Error("Update exceeds declared size")); return; }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
    output.once("open", () => { created = true; });
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), meter, output, { signal: controller.signal });
    if (bytes !== asset.sizeBytes) throw new Error("Incomplete update download");
    if (`sha256:${hash.digest("hex")}` !== asset.digest!.toLowerCase()) throw new Error("Update SHA-256 mismatch");
  } catch (error) {
    controller.abort();
    if (created) await rm(destination, { force: true });
    throw error;
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
  }
}
