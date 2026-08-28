/**
 * Screenshots the preview harnesses in this folder into docs/images/.
 *
 * The harnesses load the plugin's own styles.css over Obsidian's default theme
 * variables and reproduce the DOM the plugin builds, so these are renders of
 * the real stylesheet rather than mock-ups — but they are produced in a plain
 * Chromium, not inside Obsidian.
 *
 * Playwright is not a dependency of this plugin, because it would pull a
 * browser download into every install. Install it on demand:
 *
 *   npm i --no-save playwright && npx playwright install chromium
 *   node test/render-previews.mjs
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import { mkdir } from 'fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'docs', 'images');

/** Each shot: the harness page, the element to capture, and the output name. */
const SHOTS = [
  { file: 'ctx-preview.html', query: '', selector: '.note', out: 'contextual-popover-dark.png' },
  { file: 'ctx-preview.html', query: '?chatting', selector: '.note', out: 'contextual-popover-chat.png' },
  { file: 'ui-preview.html', query: '', selector: '.preview-shell', out: 'chat-dark.png' },
  { file: 'ui-preview.html', query: '?light', selector: '.preview-shell', out: 'chat-light.png' },
];

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // Set PW_CHROMIUM to reuse a browser that is already on the machine.
  executablePath: process.env.PW_CHROMIUM || undefined,
});

try {
  for (const shot of SHOTS) {
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1000, height: 820 } });
    await page.goto(`file://${path.join(here, shot.file)}${shot.query}`);
    // Webfonts fall back to system fonts here; wait for layout to settle.
    await page.waitForTimeout(250);
    const target = await page.locator(shot.selector).first();
    await target.screenshot({ path: path.join(outDir, shot.out), scale: 'css' });
    console.log(`rendered ${shot.out}`);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${SHOTS.length} previews written to docs/images/`);
