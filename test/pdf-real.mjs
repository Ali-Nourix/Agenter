/**
 * Reads real PDFs with real pdf.js: Chromium prints HTML to PDF (English, Persian, a mixed line, a raster-only page),
 * pdf.js extracts the text, and the harness's page layout has to give back what was typed. Optional, like the previews:
 * it needs a browser and pdf.js, which are not dependencies of the plugin.
 *
 *   npm i --no-save playwright pdfjs-dist@4 && npx playwright install chromium
 *   node test/pdf-real.mjs
 *
 * (PW_CHROMIUM=/path/to/chromium points it at a browser that is already installed.)
 */
import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
let chromium;
let pdfjs;
try {
  ({ chromium } = await import("playwright"));
  pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
} catch {
  console.log("PDF_REAL_SKIPPED (needs: npm i --no-save playwright pdfjs-dist@4)");
  process.exit(0);
}

const bundled = await build({ entryPoints: [path.join(here, "..", "src", "harness", "pdf.ts")], bundle: true, format: "esm", write: false, platform: "node", logLevel: "silent" });
const pdf = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:"DejaVu Sans","Noto Sans Arabic",sans-serif;font-size:14px;line-height:1.7;margin:28px}h1{font-size:22px}.rtl{direction:rtl;text-align:right}table{border-collapse:collapse}td,th{border:1px solid #888;padding:4px 10px}.pb{page-break-after:always}</style></head><body>${body}</body></html>`;
const sources = {
  english: page(`<h1>Quarterly Report</h1><p>Revenue grew 12% quarter over quarter. The plan for next year keeps costs flat.</p><p class="pb"></p><table><tr><th>Region</th><th>Revenue</th></tr><tr><td>North</td><td>1,200</td></tr></table>`),
  persian: page(`<div class="rtl"><h1>گزارش فصلی</h1><p>درآمد در فصل دوم نسبت به فصل اول ۱۲ درصد رشد کرد و برنامهٔ سال آینده هزینه‌ها را ثابت نگه می‌دارد.</p><p>کلمات «چگونه»، «پژوهش» و «گفتگو».</p></div>`),
  mixed: page(`<p>The word <b>Agenter</b> appears in <span class="rtl">متن فارسی با کلمهٔ Obsidian در وسط آن</span> and the sentence ends here.</p>`),
};

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const pdfs = {};
try {
  for (const [name, html] of Object.entries(sources)) {
    const tab = await browser.newPage();
    await tab.setContent(html);
    pdfs[name] = new Uint8Array(await tab.pdf({ format: "A5" }));
    await tab.close();
  }
  // A page that is only a picture of text: what a scanner makes.
  const shot = await browser.newPage({ viewport: { width: 500, height: 200 } });
  await shot.setContent(page("<h1>SCANNED TEXT</h1>"));
  const png = (await shot.screenshot()).toString("base64");
  await shot.close();
  const raster = await browser.newPage();
  await raster.setContent(page(`<img src="data:image/png;base64,${png}" width="400">`));
  pdfs.scanned = new Uint8Array(await raster.pdf({ format: "A5" }));
  await raster.close();
} finally {
  await browser.close();
}

const read = async (name) => {
  const doc = await pdfjs.getDocument({ data: pdfs[name], useSystemFonts: true, verbosity: 0 }).promise;
  const reader = new pdf.PdfReader(doc, `${name}.pdf`, async () => null);
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) out.push(await reader.page(n));
  return out;
};

let checks = 0;
const ok = (value, label) => { if (!value) throw new Error(`${label}`); checks++; };

const english = await read("english");
ok(english[0].text.includes("Revenue grew 12% quarter over quarter."), "English reads as typed");
ok(/Region \| Revenue/.test(english[1].text) && /North \| 1,200/.test(english[1].text), "a table keeps its columns");

const persian = (await read("persian"))[0].text;
ok(persian.split("\n")[0] === "گزارش فصلی", "a Persian heading reads as typed");
ok(persian.includes("درآمد در فصل دوم نسبت به فصل اول ۱۲ درصد رشد کرد و برنامهٔ سال آینده"), "a Persian paragraph reads as typed");
ok(persian.includes("«چگونه»، «پژوهش» و «گفتگو»"), "quotation marks are not reversed");

const mixed = (await read("mixed"))[0].text;
ok(mixed.includes("The word Agenter appears in متن فارسی با کلمهٔ Obsidian در وسط آن and"), "a line with both scripts reads in order");

const scanned = (await read("scanned"))[0];
ok(!scanned.readable, "a page that is only a picture has no text layer");

console.log(`PDF_REAL_OK (${checks} checks)`);
