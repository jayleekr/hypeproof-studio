// Verify prereqs once before any test runs.
//
//   1. The .app exists
//   2. wrangler dev is reachable at localhost:8787
//   3. /tmp/hps-token.txt has a workshop token
//
// If anything fails, give a hint pointing at `scripts/dev-stack.sh`.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

export const APP_BINARY = path.join(
  REPO_ROOT,
  "vscodium-base/VSCode-darwin-arm64/HypeProof Studio.app/Contents/MacOS/HypeProof Studio",
);

export const TOKEN_FILE = "/tmp/hps-token.txt";

export default async function globalSetup() {
  const errors: string[] = [];

  if (!fs.existsSync(APP_BINARY)) {
    errors.push(`✗ App binary missing: ${APP_BINARY}\n   Run: bash scripts/run-build.sh`);
  }

  if (!fs.existsSync(TOKEN_FILE)) {
    errors.push(`✗ Token file missing: ${TOKEN_FILE}\n   Run: bash scripts/dev-stack.sh`);
  } else {
    const tok = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (!tok || !tok.includes(".") || tok.length < 50) {
      errors.push(`✗ Token at ${TOKEN_FILE} looks malformed (length ${tok.length})`);
    }
  }

  try {
    const res = await fetch("http://localhost:8787/v1/health");
    if (!res.ok) errors.push(`✗ wrangler dev /v1/health returned ${res.status}`);
  } catch (err) {
    errors.push(`✗ wrangler dev not reachable at localhost:8787 (${err})\n   Run: bash scripts/dev-stack.sh`);
  }

  if (errors.length > 0) {
    console.error("\nE2E preflight failed:\n" + errors.join("\n") + "\n");
    throw new Error("E2E preflight failed — see hints above");
  }

  console.log("✓ E2E preflight: app, wrangler, token all present");
}
