import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // Electron app launch + extension activation + Anthropic streaming can be
  // slow. LLM-heavy specs (13 clinical guard, 15/16 persona) use
  // retryAssertion(tries: 3, minPasses: 3) → 3 sequential LLM turns per test,
  // each ~25-30s through sediment proxy. 90s was tight enough that the 5/25
  // suite saw all clinical-guard tests time out. 180s gives headroom without
  // slowing fast tests (timeout is a cap, not a wait).
  timeout: 180_000,
  expect: { timeout: 20_000 },

  // One Electron instance at a time — we share a single workshop session across tests.
  fullyParallel: false,
  workers: 1,
  retries: 0,

  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],

  outputDir: "test-results",

  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  globalSetup: "./fixtures/global-setup.ts",
});
