import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Preserve the CLI's own local login. Never copy credential files or forward a
// workshop/API token. The developer explicitly selects subscription funding.
export function subscriptionEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env))
    if (
      /^(ANTHROPIC_|OPENAI_|CODEX_API_KEY$|CLAUDE_CODE_(OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY)|HPS_.*TOKEN)/.test(
        key,
      )
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
        end(new Error("개발 CLI 응답 형식을 읽을 수 없습니다."));
      }
    });
    proc.on("error", () =>
      end(new Error("개발 CLI를 실행할 수 없습니다. 설치 경로를 확인하세요.")),
    );
    proc.on("close", (code) =>
      end(
        code === 0
          ? undefined
          : new Error(
              "개발 CLI 실행에 실패했습니다. 로그인과 구독 한도를 확인하세요.",
            ),
      ),
    );
    proc.stdin.end(input);
  });
}
