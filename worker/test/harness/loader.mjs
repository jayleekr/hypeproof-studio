// Shared module-loader hooks for worker tests (#255 A#11).
//
// Importing this module (for side effects) lets a plain `node
// --experimental-strip-types` process import the worker's TypeScript source:
//   - extensionless relative imports resolve to `.ts` (or `<dir>/index.ts`)
//   - `.html` / `.md` imports resolve to `export default <file contents>`,
//     mirroring wrangler's `[[rules]] type="Text"` rule in wrangler.toml.
//
// Import this FIRST (before any import that reaches src/) in every test file.

import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z0-9]+$/i.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        try {
          return nextResolve(specifier, context);
        } catch {
          // Directory modules (e.g. "../profiles" → profiles/index.ts).
          return nextResolve(`${specifier}/index.ts`, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".html") || url.endsWith(".md")) {
      const text = readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(text)};`,
      };
    }
    return nextLoad(url, context);   // .ts → built-in strip-types, etc.
  },
});
