import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const mark = new URL("../assets/brand/hypeproof-watermark.svg", import.meta.url);
export const variants = ["dark", "light", "hcDark", "hcLight"];
/** Patch only the four known editor watermark assets, before package signing. */
export async function installShellBrand(mediaDir) {
  if (!mediaDir) throw new Error("Pass the exact editor media directory");
  const files = variants.map(v => path.join(mediaDir, `letterpress-${v}.svg`));
  // Preflight all inputs before touching any target. Upstream layout drift fails closed.
  await Promise.all(files.map(f => fs.access(f)));
  const svg = await fs.readFile(mark);
  for (const file of files) await fs.writeFile(file, svg);
  return files.length;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(`HP editor watermark: ${await installShellBrand(process.argv[2])} assets installed`); }
  catch (error) { console.error(`HP editor branding failed: ${error.message}`); process.exitCode = 1; }
}
