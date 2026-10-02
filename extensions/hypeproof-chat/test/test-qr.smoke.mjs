// The QR of a test link (cr-publish #1393; CR-18, CR-T18 decode half). The code is drawn on
// the student's machine (testQr.ts, qrcode-generator) and read back here by an independent
// decoder (jsQR) from the rendered modules: what a phone camera would scan.
//
// Run: node --experimental-strip-types test/test-qr.smoke.mjs

import assert from "node:assert/strict";
import jsQR from "jsqr";

const { qrModules, qrSvg, qrDataUrl } = await import("../src/testQr.ts");

/** Rasterise a module grid (4-module quiet zone, `px` per module) to RGBA, then decode it. */
function decode(modules, px = 4) {
  const n = modules.length, q = 4, size = (n + 2 * q) * px;
  const rgba = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (modules[r][c])
        for (let y = 0; y < px; y++)
          for (let x = 0; x < px; x++) {
            const i = (((r + q) * px + y) * size + (c + q) * px + x) * 4;
            rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
          }
  return jsQR(rgba, size, size)?.data ?? null;
}

const urls = [
  "http://prj-0123456789abcdef.test.invalid:8799/l/4fUq8IIB84B-cny9Iy60WQ/",
  "https://prj-0123456789abcdef.try.hypeproof-ai.xyz/l/AAAAAAAAAAAAAAAAAAAAAA/",
  "https://a1b2-203-0-113-7.ngrok-free.app/l/zzzzzzzzzzzzzzzzzzzzzz/",
];
for (const url of urls) assert.equal(decode(qrModules(url)), url, "positive: the decoded QR equals the share URL");
console.log("✓ CR-T18 positive: the decoded QR equals the share URL (3 hosts)");

// Negative controls: the instrument must catch a code that does not carry the URL.
const url = urls[0];
const other = qrModules(url.replace("4fUq", "XXXX"));
assert.notEqual(decode(other), url, "a code of another link decodes to something else");
const blank = qrModules(url).map((row) => row.map(() => false));
assert.equal(decode(blank), null, "an empty grid decodes to nothing");
console.log("✓ CR-T18 negative: another link's code or an empty grid is not the share URL");

const svg = qrSvg(url);
assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
assert.match(svg, /fill="#fff"/, "white background whatever the theme");
assert.ok(qrDataUrl(url).startsWith("data:image/svg+xml;base64,"));
console.log("✓ the SVG image is self-contained (no network)");
