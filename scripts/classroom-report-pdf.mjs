#!/usr/bin/env node
// Remote classroom operations R6 (#751) — PDF of an approved report, from the SAME page a recipient reads.
//
//   node scripts/classroom-report-pdf.mjs --url <protected report link> --out report.pdf
//   node scripts/classroom-report-pdf.mjs --html report.html --out report.pdf
//
// There is no second layout: the page's print stylesheet (A4, light paper palette) is the PDF.
// Needs Playwright's Chromium (e2e/ has it). Runs on the operator's machine, not in the Worker.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

export async function renderReportPdf({ html, url, out, chromium }) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ javaScriptEnabled: false }); // the report page has no script; none is allowed to run
    if (url) await page.goto(url, { waitUntil: 'load' }); else await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    return await page.pdf({ path: out, format: 'A4', printBackground: false, margin: { top: '16mm', bottom: '16mm', left: '16mm', right: '16mm' } });
  } finally { await browser.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const out = arg('--out'), url = arg('--url'), file = arg('--html');
  if (!out || (!url && !file)) { console.error('usage: node scripts/classroom-report-pdf.mjs (--url <link> | --html <file>) --out <file.pdf>'); process.exit(2); }
  const { chromium } = createRequire(new URL('../e2e/package.json', import.meta.url))('@playwright/test');
  const pdf = await renderReportPdf({ html: file ? await readFile(file, 'utf8') : undefined, url, out, chromium });
  console.log(`wrote ${out} (${pdf.byteLength} bytes)`); // the URL carries the secret token: it is never echoed
}
