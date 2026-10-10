/**
 * Renders the context bar and the lines around it from the plugin's own stylesheet and component code.
 *
 *   node test/render-harness-preview.mjs [outDir]
 */
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";
import { mkdir } from "fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] ?? path.join(here, "..", "docs", "images"));
await mkdir(outDir, { recursive: true });

await build({
  stdin: { contents: 'import { ContextMeter } from "../src/context-meter"; window.AgenterPreview = { ContextMeter };', resolveDir: here, loader: "ts" },
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: path.join(here, "meter-preview.bundle.js"),
  logLevel: "silent",
});

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
try {
  for (const [query, out, selector] of [
    ["", "context-meter-dark.png", ".stack"],
    ["?light", "context-meter-light.png", ".stack"],
    ["?open", "context-meter-details-dark.png", ".stack"],
  ]) {
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 560, height: 1300 } });
    await page.goto(`file://${path.join(here, "meter-preview.html")}${query}`);
    await page.waitForTimeout(250);
    await page.locator(selector).first().screenshot({ path: path.join(outDir, out), scale: "css" });
    console.log("rendered", out);
    await page.close();
  }
} finally {
  await browser.close();
}
