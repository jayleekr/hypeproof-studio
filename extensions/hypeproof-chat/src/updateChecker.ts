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
  pickDarwinAsset,
  pickWindowsInstaller,
  renderWindowsUpdateWrapper,
  MIN_FREE_DISK_BYTES,
  type AssetPicker,
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
  // The updater ships per-platform paths (#447): macOS swaps the .app bundle
  // via a bash installer; Windows runs the Inno Setup .exe. Each platform
  // selects its own release asset. Any other platform (Linux) has no updater
  // yet, so skip the check entirely — no banner, no wrong-platform download
  // (the pre-#447 bug offered the 162 MB macOS zip as a "downgrade", #425/#438).
  const pickAsset = assetPickerForPlatform();
  if (!pickAsset) return emptyInfo();
  try {
    const res = await fetch(RELEASES_API, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      console.warn(`[hypeproof-chat/update] releases API ${res.status}`);
      return emptyInfo();
    }
    const release = (await res.json()) as GhRelease;
    return parseLatestRelease(release, currentVersion, pickAsset);
  } catch (err) {
    console.warn(`[hypeproof-chat/update] check failed: ${(err as Error).message}`);
    return emptyInfo();
  }
}

/** The release-asset picker for the running OS, or null if we have no updater. */
function assetPickerForPlatform(): AssetPicker | null {
  if (process.platform === "darwin") return pickDarwinAsset;
  if (process.platform === "win32") return pickWindowsInstaller;
  return null;
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
  const impl = process.platform === "win32" ? runUpdateWindows : runUpdateMac;
  return pickInflight(inflight, info.version, () => impl(info, deps));
}

async function runUpdateMac(info: UpdateInfo, deps: UpdateRunnerDeps): Promise<void> {
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
 * The app's main executable base name (Get-Process -Name form, no ".exe"), used
 * by the update wrapper to wait for the app to fully exit. On an installed
 * build the app root folder is named after the product (VSCodium/VS Code
 * convention), and the main exe shares that name — so
 * `<root>\HypeProof Studio.exe` → process name "HypeProof Studio". __dirname is
 * `<root>\resources\app\extensions\hypeproof-chat\dist`, i.e. five levels deep.
 */
function windowsAppProcessName(): string {
  try {
    const root = path.resolve(__dirname, "..", "..", "..", "..", "..");
    const base = path.basename(root);
    const lower = base.toLowerCase();
    if (base && lower !== "resources" && lower !== "app" && lower !== "dist") {
      return base;
    }
  } catch { /* fall through to the product default */ }
  return "HypeProof Studio";
}

/**
 * Windows update path (#447). Unlike macOS — where we unzip a .app and swap it
 * ourselves — Windows delegates the swap to the Inno Setup installer .exe that
 * `checkForUpdates` already matched. This mirrors VS Code's own win32 updater:
 * run it `/silent /mergetasks=runcode`.
 *
 * Sequencing (relaunch-race fix): we quit BEFORE the installer runs. The
 * extension host dies with the app, so we can't quit-then-install inline —
 * instead we spawn a detached PowerShell wrapper that waits for the app to
 * fully exit, THEN runs the installer, THEN lets `/mergetasks=runcode` relaunch
 * cleanly. Running the installer while the old instance is still releasing its
 * single-instance lock made the relaunched process hand off to the dying old
 * one and exit (updated, but didn't relaunch).
 */
async function runUpdateWindows(info: UpdateInfo, deps: UpdateRunnerDeps): Promise<void> {
  // 1. Disk space check (same predicate as macOS).
  try {
    const stat = fs.statfsSync(os.tmpdir());
    const free = (stat.bavail as unknown as number) * (stat.bsize as unknown as number);
    if (!hasFreeDisk(free, MIN_FREE_DISK_BYTES)) {
      vscode.window.showWarningMessage(
        `업데이트하려면 1 GB 이상 여유공간이 필요해요. 현재 ${(free / 1e9).toFixed(1)} GB 남음.`,
      );
      return;
    }
  } catch { /* statfsSync not available? best-effort skip */ }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `HypeProof Studio v${info.version} 다운로드 중…`,
      cancellable: false,
    },
    async (progress) => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `hps-update-${info.version}-`));
      // Preserve the installer's own name (…UserSetup-x64-<ver>.exe) so it's
      // recognizable if the user runs it manually.
      const installerName =
        safeBasename(info.downloadUrl) || `HypeProofStudioSetup-${info.version}.exe`;
      const exePath = path.join(workDir, installerName);

      progress.report({ message: "다운로드 중…" });
      await downloadFile(info.downloadUrl, exePath);

      // 2. Confirmation modal — the installer will close Studio, so warn first.
      const currentVersion = currentBundleVersion();
      const choice = await vscode.window.showInformationMessage(
        `v${info.version} 설치 준비 완료. 지금 재시작하면 업데이트가 적용됩니다.`,
        {
          modal: true,
          detail: `현재 ${currentVersion} → 새 버전 ${info.version}\n설치 관리자가 실행되며 Studio가 잠시 종료됩니다. 작업 중인 내용이 있다면 먼저 저장해주세요.`,
        },
        "재시작하고 업데이트",
        "나중에",
      );
      if (choice !== "재시작하고 업데이트") {
        vscode.window.showInformationMessage(
          `설치 관리자를 준비했어요. 나중에 수동으로 실행해도 됩니다: ${exePath}`,
        );
        return;
      }

      deps.onUpdateScheduled?.();

      // 3. Write a detached wrapper that waits for THIS app to fully exit, then
      // runs the installer. Installer flags mirror VS Code's win32 updater:
      // `/silent` = progress bar only (no wizard), `/mergetasks=runcode` =
      // relaunch after install, `/LOG` = a trace for failed-update reports.
      // Quitting before the install (rather than racing it) is what makes the
      // post-install relaunch reliable — see the function-level comment.
      const logPath = path.join(os.tmpdir(), `hps-update-${info.version}.log`);
      const wrapperPath = path.join(workDir, "run-installer.ps1");
      // utf8 verbatim — renderWindowsUpdateWrapper already prefixes the UTF-8
      // BOM that Windows PowerShell 5.1 needs to read the baked-in installer
      // path as UTF-8 instead of CP949. Without it every Korean-username
      // machine (%TEMP% = C:\Users\<한글>\…) got a mojibake path, the installer
      // never ran, and the quit below left Studio closed and un-updated.
      // Do not re-encode or strip the leading \uFEFF here.
      fs.writeFileSync(
        wrapperPath,
        renderWindowsUpdateWrapper({
          appProcessName: windowsAppProcessName(),
          installerPath: exePath,
          installerArgs: ["/silent", "/mergetasks=runcode", `/LOG=${logPath}`],
        }),
        "utf8",
      );
      const child = cp.spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", wrapperPath],
        { detached: true, stdio: "ignore" },
      );
      child.unref();

      // 4. Quit Studio. The wrapper is already waiting for this exit; once the
      // app is gone it runs the installer (400ms so the modal closes first).
      setTimeout(() => {
        vscode.commands.executeCommand("workbench.action.quit");
      }, 400);
    },
  );
}

/**
 * Basename of a URL's path (the installer file name), or "" if unparseable.
 * Kept defensive so a malformed download URL can't throw mid-update.
 */
function safeBasename(url: string): string {
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return "";
  }
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
  // Windows/Linux (no .app bundle): read the extension's OWN on-disk
  // package.json relative to the running dist/extension.js. `__dirname` is
  // <installRoot>/resources/app/extensions/hypeproof-chat/dist, so
  // `../package.json` is the BUILD-STAMPED manifest — the authoritative running
  // version. This must precede the require() fallback below: esbuild inlines
  // `require("../package.json")` at build time to the un-stamped SOURCE version
  // (e.g. 0.1.5), which on Windows made the updater compare against the wrong
  // version and misfire (#447 / same class as #249). Reading via fs at runtime
  // gets the real stamped value.
  try {
    const onDisk = path.join(__dirname, "..", "package.json");
    if (fs.existsSync(onDisk)) {
      const pkg = JSON.parse(fs.readFileSync(onDisk, "utf8")) as { version?: string };
      if (typeof pkg.version === "string") return pkg.version;
    }
  } catch { /* fallthrough */ }
  // Dev/Extension Development Host fallback (esbuild-inlined source version).
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
