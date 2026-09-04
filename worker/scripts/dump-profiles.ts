#!/usr/bin/env -S node --experimental-strip-types
// Dump every registered cohort profile as a JSON array to stdout — including
// the fully-resolved `system_prompt` text — so the studio-local cohort-harness
// validator can lint them without importing any worker code:
//
//   node --experimental-strip-types scripts/dump-profiles.ts \
//     | python3 scripts/cohort-harness/validate.py
//
// (wired as `npm run validate-profiles`).
//
// Why the hook dance: profile modules do `import md from "../prompts/<id>.md"`,
// which only works because wrangler.toml has a `[[rules]] type="Text"` rule.
// Plain Node has no .md loader, so we register the SAME synchronous text-import
// hook smoke.mjs uses (`.md`/`.html` → `export default <contents>`; extensionless
// relative specifiers → `.ts`) BEFORE dynamically importing the registry.
// registerHooks only affects subsequent imports, hence the dynamic import.

import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Mirror tsconfig "allowImportingTsExtensions": let extensionless relative
    // imports (e.g. `./types`) resolve to their `.ts` sibling.
    if (specifier.startsWith(".") && !/\.[a-z0-9]+$/i.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(specifier, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".md") || url.endsWith(".html") || url.endsWith(".yaml")) {
      const text = readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(text)};`,
      };
    }
    return nextLoad(url, context); // .ts → built-in strip-types
  },
});

const { listProfiles } = await import("../src/profiles/index.ts");

const profiles = listProfiles();
process.stdout.write(JSON.stringify(profiles, null, 2) + "\n");
