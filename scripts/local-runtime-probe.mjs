// Probe login through official CLIs, without reading or exporting credentials.
import { claudeStatus } from "../extensions/hypeproof-chat/src/localRuntime/claudeClient.mjs";
import { CodexLocalClient } from "./lib/codex-local-client.mjs";
const [provider, executable] = process.argv.slice(2);
try {
  if (provider === "claude")
    console.log(JSON.stringify(claudeStatus(executable)));
  else if (provider === "codex") {
    const client = new CodexLocalClient({ executable });
    try {
      const info = await client.connect();
      if (!info.models.length)
        throw Error("사용 가능한 Codex 모델이 없습니다.");
      console.log(
        JSON.stringify({
          provider,
          model: info.models[0].id,
          label: "Codex · 로컬 구독",
          models: info.models,
        }),
      );
    } finally {
      client.close();
    }
  } else throw Error("Choose claude or codex.");
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
