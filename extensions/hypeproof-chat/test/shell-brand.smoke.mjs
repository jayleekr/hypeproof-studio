import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installShellBrand, variants } from "../../../scripts/install-shell-brand.mjs";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hp-brand-"));
try {
  await fs.writeFile(path.join(dir, "letterpress-dark.svg"), "original");
  await assert.rejects(installShellBrand(dir));
  assert.equal(await fs.readFile(path.join(dir, "letterpress-dark.svg"), "utf8"), "original");
  for (const v of variants) await fs.writeFile(path.join(dir, `letterpress-${v}.svg`), "original");
  assert.equal(await installShellBrand(dir), 4);
  for (const v of variants) assert.match(await fs.readFile(path.join(dir, `letterpress-${v}.svg`), "utf8"), /#90A96A/);
  assert.equal(await installShellBrand(dir), 4);
  const manifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url)));
  assert.equal(manifest.contributes.configurationDefaults["workbench.activityBar.location"], "hidden");
  const theme = JSON.parse(await fs.readFile(new URL("../media/hypeproof-theme.json", import.meta.url)));
  assert.equal(theme.colors["button.background"], "#D5F279");
  console.log("PASS HP shell: missing asset leaves originals; all variants and repeated application; packaged theme/defaults");
} finally { await fs.rm(dir, { recursive: true, force: true }); }
