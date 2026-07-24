// Orchestrates the auto-update flow (#72). Pure helpers live in
// updateCheckerHelpers.ts so they can be unit-tested without a vscode host;
// this file handles network, fs, child processes, and the VS Code UI.
//
// Flow:
//   1. checkForUpdates() — hits GitHub Releases API, returns UpdateInfo.
//   2. If banner is appropriate (not dismissed for this version), push to
//      webview via ChatPanelProvider.setAvailableUpdate().
//   3. On user "Install Now" (from banner → openInstallUpdate webview msg),
//      runUpdate() downloads → unzips → strips quarantine → writes
//      installer.sh → spawns detached → tells extension host to quit.
//   4. installer.sh handles the actual .app swap + re-launch (defined in
//      renderInstallerScript()).

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as cp from "child_process";
import {
  compareVersions,
  parseLatestRelease,
  detectAppBundle,
  renderInstallerScript,
  shouldShowBanner,
  hasFreeDisk,
  pickInflight,
  MIN_FREE_DISK_BYTES,
  type GhRelease,
  type UpdateInfo,
} from "./updateCheckerHelpers";

const RELEASES_API = "https://api.github.com/repos/jayleekr/hypeproof-studio-releases/releases/latest";
const EXPECTED_BUNDLE_ID = "ai.hypeproof.studio";
const CHECK_INTERVAL_MS = 24 * 3600 * 1000;
const INITIAL_DELAY_MS = 30 * 1000;
const DISMISSAL_KEY = "hypeproofChat.updateDismissals";

/**
 * Hit the public releases API. No auth — GitHub allows 60 unauth req/h/IP.
 * The 24h cadence + 1 strructor per user means we're nowhere near the limit.
 */
export async function checkForUpdates(currentVersion: string): Promise<UpdateInfo> {
  // #425 — the auto-update flow is macOS-only: the asset matcher defaults to
  // `darwin-arm64.zip`, `detectAppBundle` returns null off an .app bundle (so
  // `runUpdate` bails and the version compare falls back to the esbuild-inlined
  // number), and `renderInstallerScript` is bash + osascript/xattr/PlistBuddy.
  // On Windows/Linux this surfaced a dead, misleading banner offering the 162 MB
  // macOS zip (often as a "downgrade"). Until a per-platform update path exists,
  // skip the check entirely off macOS — no banner, no wrong-platform download.
  if (process.platform !== "darwin") return emptyInfo();
  try {
    const res = await fetch(RELEASES_API, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      console.warn(`[hypeproof-chat/update] releases API ${res.status}`);
      return emptyInfo();
    }
    const release = (await res.json()) as GhRelease;
    return parseLatestRelease(release, currentVersion);
  } catch (err) {
    console.warn(`[hypeproof-chat/update] check failed: ${(err as Error).message}`);
    return emptyInfo();
  }
}

function emptyInfo(): UpdateInfo {
  return {
    available: false,
    version: "",
    downloadUrl: "",
    releaseUrl: "",
    notes: "",
    sizeBytes: 0,
  };
}

export interface UpdateRunnerDeps {
  context: vscode.ExtensionContext;
  /**
   * Hook so the provider can clear its banner after a successful kick-off
   * (the modal is still up; the .app will quit shortly).
   */
  onUpdateScheduled?: () => void;
}

/**
 * Full update orchestration. Idempotent against double-clicks via a Map
 * keyed on target version.
 */
const inflight = new Map<string, Promise<void>>();

export function runUpdate(info: UpdateInfo, deps: UpdateRunnerDeps): Promise<void> {
  if (!info.available) return Promise.resolve();
  return pickInflight(inflight, info.version, () => runUpdateImpl(info, deps));
}

async function runUpdateImpl(info: UpdateInfo, deps: UpdateRunnerDeps): Promise<void> {
  // 1. Locate the running .app. If we're in dev (Extension Development Host),
  // there's no /Applications path to replace; bail with a friendly toast.
  const appPath = detectAppBundle(process.execPath);
  if (!appPath) {
    vscode.window.showInformationMessage(
      "현재 실행 중인 앱이 .app 번들이 아니에요. 개발 환경이라면 자동 업데이트는 동작하지 않습니다.",
    );
    return;
  }

  // 2. Disk space check (pure predicate in updateCheckerHelpers.hasFreeDisk)
  try {
    const stat = fs.statfsSync(os.tmpdir());
    const free = (stat.bavail as unknown as number) * (stat.bsize as unknown as number);
    if (!hasFreeDisk(free, MIN_FREE_DISK_BYTES)) {
      vscode.window.showWarningMessage(
        `업데이트하려면 1 GB 이상 여유공간이 필요해요. 현재 ${(free / 1e9).toFixed(1)} GB 남음.`,
      );
      return;
    }
  } catch { /* statfsSync not available pre-node-20? best-effort skip */ }

  // 3. Download + extract with progress notification
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `HypeProof Studio v${info.version} 다운로드 중…`,
      cancellable: false,
    },
    async (progress) => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `hps-update-${info.version}-`));
      const zipPath = path.join(workDir, "update.zip");

      progress.report({ message: "다운로드 중…" });
      await downloadFile(info.downloadUrl, zipPath);

      progress.report({ message: "압축 풀기…" });
      cp.execSync(`unzip -q ${shellQuote(zipPath)} -d ${shellQuote(workDir)}`);

      // The zip contains a top-level "HypeProof Studio.app" — find it.
      const candidates = fs.readdirSync(workDir).map((n) => path.join(workDir, n));
      const newAppPath = candidates.find((c) => c.endsWith(".app") && fs.statSync(c).isDirectory());
      if (!newAppPath) {
        throw new Error("zip 안에서 .app 번들을 찾지 못했어요.");
      }

      progress.report({ message: "검역 속성 제거…" });
      try {
        cp.execSync(`xattr -dr com.apple.quarantine ${shellQuote(newAppPath)}`);
      } catch { /* xattr returns non-zero if no attrs to strip — that's fine */ }

      progress.report({ message: "설치 스크립트 준비…" });

      // 4. Write installer.sh + log path
      const supportDir = path.join(os.homedir(), "Library", "Application Support", "HypeProof-Studio");
      fs.mkdirSync(supportDir, { recursive: true });
      const installerPath = path.join(supportDir, `installer-${info.version}.sh`);
      const logDir = path.join(os.homedir(), "Library", "Logs", "HypeProofStudio");
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, `update-${info.version}.log`);

      const currentVersion = currentBundleVersion(appPath);
      const script = renderInstallerScript({
        newAppPath,
        oldAppPath: appPath,
        expectedBundleId: EXPECTED_BUNDLE_ID,
        newVersion: info.version,
        oldVersion: currentVersion,
        logPath,
      });
      fs.writeFileSync(installerPath, script, { mode: 0o755 });

      // 5. Confirmation modal — give the user a clear "this will restart Studio"
      // moment so the auto-quit isn't surprising.
      const choice = await vscode.window.showInformationMessage(
        `v${info.version} 설치 준비 완료. 지금 재시작하면 업데이트가 적용됩니다.`,
        { modal: true, detail: `현재 ${currentVersion} → 새 버전 ${info.version}\n작업 중인 내용이 있다면 먼저 저장해주세요.` },
        "재시작하고 업데이트",
        "나중에",
      );
      if (choice !== "재시작하고 업데이트") {
        vscode.window.showInformationMessage(
          `설치 스크립트는 준비됐어요. 다음 재시작 때 적용하거나, 수동으로 실행: bash ${installerPath}`,
        );
        return;
      }

      deps.onUpdateScheduled?.();

      // 6. Spawn the installer detached + tell Studio to quit. Using
      // `setsid bash -c` would be ideal but macOS bash doesn't have setsid;
      // `nohup ... & disown` inside a wrapper achieves the same.
      //
      // The wrapper sleeps 2s to give Studio time to fully exit (otherwise
      // the installer's pgrep loop falls back to its own 10s wait, but
      // shaving that here makes the user experience tighter).
      //
      // spawn(detached:true, stdio:'ignore', unref) is the canonical Node
      // pattern for "survive my exit". exec() doesn't support detached;
      // child must inherit nothing from our process to safely outlive us.
      const wrapper = `(sleep 2; bash ${shellQuote(installerPath)}) >${shellQuote(logPath + ".detach")} 2>&1`;
      const child = cp.spawn("/bin/bash", ["-c", wrapper], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      // 7. Quit Studio so the installer can replace the .app
      // 700ms delay so the toast renders + the user sees the modal close
      setTimeout(() => {
        vscode.commands.executeCommand("workbench.action.quit");
      }, 700);
    },
  );
}

/**
 * Read the bundled extension's version (== Studio's effective version for our
 * purposes; we cut Studio + extension in lockstep).
 */
export function currentBundleVersion(appPath?: string): string {
  // When no explicit path is given, resolve the running .app bundle so the
  // update *check* reads the same stamped on-disk package.json as the install
  // path (runUpdate already passes detectAppBundle(process.execPath)). Without
  // this, the no-arg callers (checkForUpdates / installUpdate /
  // scheduleUpdateChecks in extension.ts) fall through to the esbuild-inlined
  // require("../package.json") below — frozen at build time to the un-stamped
  // source version (e.g. 0.1.5) — so the updater perpetually offers the
  // version that is already installed and loops forever (#249; residual of
  // #213 Gap #3 / #206).
  const resolved = appPath ?? detectAppBundle(process.execPath) ?? undefined;
  // Prefer the bundled extension's package.json — it's part of the .app
  // we're trying to replace, so it's authoritative for "what's running".
  try {
    const candidate = resolved
      ? path.join(resolved, "Contents", "Resources", "app", "extensions", "hypeproof-chat", "package.json")
      : null;
    if (candidate && fs.existsSync(candidate)) {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: string };
      if (typeof pkg.version === "string") return pkg.version;
    }
  } catch { /* fallthrough */ }
  // Dev/Extension Development Host fallback
  try {
    const ourPkg = require("../package.json") as { version?: string };
    if (typeof ourPkg.version === "string") return ourPkg.version;
  } catch { /* ignore */ }
  return "0.0.0";
}

/**
 * Streaming download with a 60s timeout per chunk. On failure, deletes the
 * partial file and re-throws.
 */
async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }
  const fileHandle = fs.createWriteStream(dest);
  try {
    // @ts-ignore — node-fetch / undici body stream is async-iterable
    for await (const chunk of res.body) {
      fileHandle.write(chunk);
    }
  } finally {
    fileHandle.end();
  }
  // Wait for flush — `close` callback may receive an arg, but Promise<void>
  // expects a zero-arg resolver. Wrap so the types line up.
  await new Promise<void>((r) => fileHandle.on("close", () => r()));
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Scheduler — wires checkForUpdates into the extension lifecycle.

export interface SchedulerDeps {
  context: vscode.ExtensionContext;
  /** Push update info to the webview (so it can render a banner). null clears it. */
  pushUpdateBanner: (info: UpdateInfo | null) => void;
  currentVersion: string;
}

export function scheduleUpdateChecks(deps: SchedulerDeps): vscode.Disposable {
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  const run = async () => {
    if (disposed) return;
    const info = await checkForUpdates(deps.currentVersion);
    if (disposed) return;
    if (!info.available) {
      deps.pushUpdateBanner(null);
      return;
    }
    const dismissals = deps.context.globalState.get<Record<string, number>>(DISMISSAL_KEY, {});
    const now = Math.floor(Date.now() / 1000);
    if (shouldShowBanner(info, dismissals, now)) {
      deps.pushUpdateBanner(info);
    } else {
      deps.pushUpdateBanner(null);
    }
  };

  // Fire once after a short delay so activation isn't blocked on a network round-trip.
  timer = setTimeout(() => {
    void run();
    // Then repeat every 24h.
    timer = setInterval(() => { void run(); }, CHECK_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  return {
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export async function dismissVersion(
  context: vscode.ExtensionContext,
  version: string,
): Promise<void> {
  const dismissals = context.globalState.get<Record<string, number>>(DISMISSAL_KEY, {});
  dismissals[version] = Math.floor(Date.now() / 1000);
  await context.globalState.update(DISMISSAL_KEY, dismissals);
}

// Re-export for callers that just want to read state
export { compareVersions } from "./updateCheckerHelpers";
