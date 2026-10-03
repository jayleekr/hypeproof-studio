// The QR code of a test link (cr-publish #1393; CR-18). Drawn on the student's own machine
// from the share URL; nothing is sent anywhere to make it. vscode-free.
//
// `qrcode-generator` (MIT, no dependencies) encodes; test/test-qr.smoke.mjs decodes the
// rendered modules with an independent decoder (jsQR) and checks the result is the URL.

import qrcode from "qrcode-generator";

/** The module grid (true = dark), with no quiet zone. ECC level M, version chosen to fit. */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** An SVG of the code with a 4-module quiet zone, black on white whatever the theme. */
export function qrSvg(text: string, px = 4): string {
  const m = qrModules(text);
  const n = m.length;
  const q = 4;
  const size = (n + 2 * q) * px;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r]![c]) d += `M${(c + q) * px} ${(r + q) * px}h${px}v${px}h-${px}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/** A data URL the webview can show in an <img> (its CSP allows data: images). */
export function qrDataUrl(text: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(qrSvg(text), "utf8").toString("base64")}`;
}
