// Common measurement core (#1042, measurement-core unit 1).
//
// Host-independent: no VS Code API, no Worker bindings, no Chalk, no cohort
// credentials, no network. Studio App and the Service import THIS code; the old
// file-level twin (a textual drift lock between two copies) is gone. Purity is
// locked by worker/test/measurement-core.test.mjs and by the App typecheck, which
// compiles these files without Cloudflare or VS Code types.
export const MEASUREMENT_CORE_VERSION = "measurement-core/0.1.0";

export * from "./learning-events.ts";
export * from "./legacy-observation.ts";
export * from "./evidence.ts";
export * from "./normalize.ts";
export * from "./capability-models.ts";
export * from "./interpretation.ts";
export * from "./local-record.ts";
