// Shared module-loader hooks for worker tests (#255 A#11).
//
// Importing this module (for side effects) lets a plain `node
// --experimental-strip-types` process import the worker's TypeScript source:
//   - extensionless relative imports resolve to `.ts` (or `<dir>/index.ts`)
//   - `.html` / `.md` / `.yaml` / `.css` imports resolve to `export default <file
//     contents>`, mirroring wrangler's `[[rules]] type="Text"` rule in wrangler.toml.
//
// The list here must track the Text globs in BOTH wrangler.toml files. `.css`
// arrived with chalk/src/ui/shell.css (#1145): pages are bundled as static text,
// so a shared stylesheet cannot be injected into them and is served as its own
// route instead. A glob added there and forgotten here fails as
// ERR_UNKNOWN_FILE_EXTENSION at import time, not as a wrong answer.
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
    if (url.endsWith(".html") || url.endsWith(".md") || url.endsWith(".yaml") || url.endsWith(".css") || url.endsWith("/ui/shell.js")) {
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
