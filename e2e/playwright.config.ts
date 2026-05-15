import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // Electron app launch + extension activation + Anthropic streaming can be slow.
  timeout: 90_000,
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
