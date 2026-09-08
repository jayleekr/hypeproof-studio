// Re-evaluate an existing synthetic Mac fixture; never regenerate its artifacts.
import "./harness/loader.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createMockEnv } from "./harness/index.mjs";
const { assessNativeObservation } = await import(
  "../src/lib/native-assessment.ts"
);
const { validateObservation } = await import(
  "../src/lib/native-observation.ts"
);
const { getProfile } = await import("../src/profiles/index.ts");
const { MODEL_MAP } = await import("../src/profiles/types.ts");
if (process.env.HPS_NATIVE_LIVE !== "1" || !process.env.ANTHROPIC_API_KEY)
  throw Error("requires explicit synthetic live test environment");
const file = resolve(process.argv[2]);
const { batch } = validateObservation(JSON.parse(readFileSync(file, "utf8")));
const env = createMockEnv({
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_PROXY_URL: undefined,
  },
});
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await real(input, init);
  writeFileSync(file + ".provider.json", await response.clone().text(), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: response.status,
      request_id: response.headers.get("request-id"),
    }),
  );
  return response;
};
try {
  const result = await assessNativeObservation(
    env,
    "studio-native-trial",
    MODEL_MAP[getProfile("studio-native-trial").model.default],
    batch,
  );
  writeFileSync(file + ".assessment.json", JSON.stringify(result, null, 2), {
    mode: 0o600,
  });
  console.log("PASS same recorded synthetic events, real assessment");
} catch (error) {
  console.log("FAIL", error.message);
  process.exitCode = 1;
}
