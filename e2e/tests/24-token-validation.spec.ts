// REQ-A5 (invalid stored token → re-prompt) + REQ-B3 (profile validation).
//
// Mock the /v1/profile endpoint to return 401. Launch with a preseeded
// token. autoOnboard's profile probe should fail, show a warning, and
// re-open the setToken QuickInput — proving the recovery path works.

import { test, expect, _electron as electron } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { APP_BINARY, TOKEN_FILE } from "../fixtures/global-setup";

async function startProfileMock(status: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    if (req.method === "GET" && req.url?.endsWith("/profile")) {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "mocked", code: "expired" } }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("REQ-A5 + REQ-B3: stored token but /v1/profile 401 → re-prompt setToken", async () => {
  const mock = await startProfileMock(401);
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hps-e2e-b3-"));
  const userDir = path.join(userDataDir, "User");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDir, "settings.json"),
    JSON.stringify({
      "hypeproofChat.proxyUrl": `http://127.0.0.1:${mock.port}/v1`,
      "workbench.startupEditor": "none",
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
    }),
  );
  fs.writeFileSync(
    path.join(userDir, "hps-test-state.json"),
    JSON.stringify({ token, coach: { name: "코디", personality: "" } }),
  );
  const wsDir = path.join(userDataDir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });

  const app = await electron.launch({
    executablePath: APP_BINARY,
    args: [
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${path.join(userDataDir, "extensions")}`,
      "--disable-workspace-trust",
      "--password-store=basic",
      "--disable-updates",
      "--skip-welcome",
      "--skip-release-notes",
      "--no-sandbox",
      wsDir,
    ],
    env: {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      HPS_TEST_E2E: "1",
      HPS_TEST_TOKEN: token,
      HPS_TEST_COACH_NAME: "코디",
    },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForSelector(".monaco-workbench", { timeout: 30_000 });

  try {
    // autoOnboard runs profile probe → 401 → warning toast + re-prompt setToken.
    // The setToken QuickInput should appear with "Workshop token" prompt.
    const tokenPrompt = win
      .locator(".quick-input-widget")
      .filter({ hasText: /Workshop token|선생님께 받은 토큰/i });
    await expect(tokenPrompt).toBeVisible({ timeout: 30_000 });
    await win.keyboard.press("Escape");
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    await mock.close();
  }
});
