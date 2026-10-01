// In-app Experiment Browser run (cr-browser #1391), AI Verify run (cr-verify #1392,
// verify-app.spec.ts) and Publish for User Test run (cr-publish #1393, publish-app.spec.ts). Separate from the main suite: it
// brings its own local Service (app-service.mjs) and never needs wrangler dev.
//
//   HPS_APP_PATH="<prepared app copy>" npx playwright test -c curriculum-runtime/playwright.config.ts
import { defineConfig } from "@playwright/test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CR_APP_PORT = Number(process.env.HPS_CR_APP_PORT || 18931);
// Read by fixtures/app.ts when it is imported by the spec (worker processes inherit this env).
process.env.HPS_E2E_TOKEN_FILE ||= path.join(here, "../test-results/cr-app/token.txt");
process.env.HPS_E2E_PROXY_URL ||= `http://127.0.0.1:${CR_APP_PORT}/v1`;
// Quiet mode stays on (off-screen, shown inactive, never focusable), but the app is not
// hidden: a hidden app's integrated browser paints no frames, so every CR observation's
// screenshot times out ("CDP Page.captureScreenshot timed out", run of 2026-10-01).
process.env.HPS_QUIET_NO_HIDE ||= "1";

export default defineConfig({
  testDir: here,
  testMatch: /(app-layer|verify-app|publish-app)\.spec\.ts$/,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: path.join(here, "../test-results/cr-app/playwright"),
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
