import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Preserve the CLI's own local login. Never copy credential files or forward a
// workshop/API token. The developer explicitly selects subscription funding.
//
// Deny by shape, not by a list of known names (#1041 review): the earlier
// `HPS_.*TOKEN` rule let HPS_ADMIN_PASSWORD, HPS_*_SECRET and HPS_*_KEY through.
// Every HPS_ variable belongs to this product's own runtime, and a name that
// looks like a credential is dropped whoever owns it. A new secret added later
// is therefore excluded without editing this file.
const VENDOR_CREDENTIAL =
  /^(ANTHROPIC_|OPENAI_|CODEX_API_KEY$|CLAUDE_CODE_(OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY))/;
const CREDENTIAL_SHAPED = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|SESSION_KEY)(_|$)/;

export function subscriptionEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env))
    if (
      key.startsWith("HPS_") ||
      VENDOR_CREDENTIAL.test(key) ||
      CREDENTIAL_SHAPED.test(key.toUpperCase())
    )
      delete env[key];
  delete env.CLAUDECODE;
  return env;
}

export function jsonProcess(
  executable,
  args,
  {
    cwd,
    env = subscriptionEnv(),
    input = "",
    signal,
    onEvent = () => {},
    timeout = 180000,
  } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("개발 모델 요청을 중지했습니다."));
      return;
    }
    const proc = spawn(executable, args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let finished = false,
      bytes = 0,
      nonJsonLines = 0,
      result;
    const kill = () => {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {}
    };
    const end = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // Kill the group only on the paths where the CLI is still running (abort,
      // timeout, spawn error, oversized output). Measured on macOS for #1041
      // review 3: after the group leader exits normally, `kill(-pid)` returns
      // ESRCH even while a grandchild is still alive, so it cannot reap what the
      // CLI left behind. Such a child is reparented to launchd and finishes on
      // its own; a dev-only run does not get a stronger guarantee here.
      if (error) {
        kill();
        reject(error);
      } else resolve(result);
    };
    const abort = () => end(new Error("개발 모델 요청을 중지했습니다."));
    const timer = setTimeout(
      () => end(new Error("개발 모델 응답 시간이 초과되었습니다.")),
      timeout,
    );
    signal?.addEventListener("abort", abort, { once: true });
    proc.stderr.on("data", () => {}); // CLI diagnostics can include account/config data.
    proc.stdin.on("error", () => {});
    const lines = createInterface({ input: proc.stdout });
    lines.on("line", (line) => {
      if (finished) return;
      bytes += Buffer.byteLength(line);
      if (bytes > 2_000_000) {
        end(new Error("개발 모델 응답이 너무 큽니다."));
        return;
      }
      try {
        const event = JSON.parse(line);
        if (event.type === "result") result = event;
        onEvent(event);
      } catch {
        // A CLI prints update notices and warnings on stdout too (#1041 review).
        // One such line must not end the session; a run that never delivers a
        // `result` event still fails, on close.
        nonJsonLines += 1;
      }
    });
    proc.on("error", () =>
      end(new Error("개발 CLI를 실행할 수 없습니다. 설치 경로를 확인하세요.")),
    );
    proc.on("close", (code) => {
      if (code !== 0) {
        end(
          new Error(
            "개발 CLI 실행에 실패했습니다. 로그인과 구독 한도를 확인하세요.",
          ),
        );
        return;
      }
      if (!result) {
        end(
          new Error(
            nonJsonLines > 0
              ? "개발 CLI 응답 형식을 읽을 수 없습니다."
              : "개발 CLI가 결과를 보내지 않았습니다.",
          ),
        );
        return;
      }
      end();
    });
    proc.stdin.end(input);
  });
}
