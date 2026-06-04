/**
 * End-to-end smoke test for the canvas editor.
 *
 * Unlike `ai-tools.e2e.ts` this downloads NO model weights — it drives the
 * editor's happy path in a real browser and asserts the chrome + the migrated
 * tools work without console errors:
 *   open → render → redact (draw → destructive burn) → annotate (draw) →
 *   crop (drag → apply) → signature (pad → place → embed) → OCR panel mounts →
 *   organize (delete → assemble) → overview/focus → flatten → metadata/scrub →
 *   extract → page numbers → fill-form → bookmarks → attachments.
 * OCR's engine is never run here (it would fetch model weights); the step only
 * asserts the panel is wired.
 *
 * Requirements: Chrome at CHROME_PATH (default macOS path) and the dev server
 * at http://localhost:5173 (`vp dev`). Fixture: tests/fixtures/multipage.pdf.
 *
 * Run:  node --experimental-strip-types tests/e2e/editor-smoke.ts
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launch } from "puppeteer-core";

const DEV_URL = process.env.E2E_URL ?? "http://localhost:5173";
const CHROME_PATH =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FIXTURE_PATH = resolve(import.meta.dirname, "../fixtures/multipage.pdf");
const USER_DATA_DIR =
  process.env.E2E_USER_DATA_DIR ?? resolve(import.meta.dirname, "../.puppeteer-profile-editor");

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!existsSync(CHROME_PATH)) fail(`Chrome not found at ${CHROME_PATH} (set CHROME_PATH).`);
if (!existsSync(FIXTURE_PATH)) fail(`Fixture not found at ${FIXTURE_PATH}.`);

/** Click the first visible element whose trimmed text equals `label`. */
async function clickByText(page: Page, label: string): Promise<boolean> {
  return page.evaluate((text) => {
    const els = Array.from(document.querySelectorAll("button, a, [role=button]"));
    const el = els.find((e) => (e.textContent ?? "").trim().toLowerCase() === text.toLowerCase());
    if (!el) return false;
    (el as HTMLElement).click();
    return true;
  }, label);
}

/** Wait until the page's visible text matches `re`. Preserves the regex flags
 *  (e.g. `i`) — `document.body.innerText` reflects CSS text-transform, so an
 *  `uppercase`-styled label only matches case-insensitively. */
async function waitForText(page: Page, re: RegExp, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    (src: string, flags: string) => new RegExp(src, flags).test(document.body.innerText),
    {
      timeout,
    },
    re.source,
    re.flags,
  );
}

/** Drag a rectangle on the focused page, in page-fraction coordinates. */
async function drawOnPage(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const img = await page.$('img[alt="Page 1"]');
  if (!img) fail("Focus page image not found for drawing.");
  const bb = await img.boundingBox();
  if (!bb) fail("Focus page image has no layout box.");
  const x1 = bb.x + bb.width * from.x;
  const y1 = bb.y + bb.height * from.y;
  const x2 = bb.x + bb.width * to.x;
  const y2 = bb.y + bb.height * to.y;
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 6 });
  await page.mouse.move(x2, y2, { steps: 6 });
  await page.mouse.up();
}

/** Click the focused page at a fraction of its box (used to place a signature). */
async function clickOnPage(page: Page, fx: number, fy: number): Promise<void> {
  const img = await page.$('img[alt="Page 1"]');
  if (!img) fail("Focus page image not found for placement.");
  const bb = await img.boundingBox();
  if (!bb) fail("Focus page image has no layout box.");
  await page.mouse.click(bb.x + bb.width * fx, bb.y + bb.height * fy);
}

/** Scribble one stroke on the signature pad so it emits a PNG data-URL. */
async function scribbleOnPad(page: Page): Promise<void> {
  const pad = await page.$('canvas[aria-label^="Signature drawing area"]');
  if (!pad) fail("Signature pad canvas not found.");
  const bb = await pad.boundingBox();
  if (!bb) fail("Signature pad has no layout box.");
  const cy = bb.y + bb.height / 2;
  await page.mouse.move(bb.x + bb.width * 0.2, cy);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width * 0.5, cy - bb.height * 0.25, { steps: 5 });
  await page.mouse.move(bb.x + bb.width * 0.8, cy, { steps: 5 });
  await page.mouse.up();
}

async function main() {
  const errors: string[] = [];
  const browser = await launch({
    executablePath: CHROME_PATH,
    userDataDir: USER_DATA_DIR,
    headless: true,
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  try {
    page.setDefaultTimeout(30_000);
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e: unknown) =>
      errors.push(`pageerror: ${e instanceof Error ? e.message : String(e)}`),
    );

    console.log(`→ Loading ${DEV_URL}`);
    await page.goto(DEV_URL, { waitUntil: "networkidle2" });

    // 1. Editor-first CTA → editor dropzone → upload fixture → focus render.
    if (!(await clickByText(page, "Open the editor"))) fail("'Open the editor' CTA not found.");
    await page.waitForSelector("input[type=file]", { timeout: 15_000 });
    const input = await page.$("input[type=file]");
    if (!input) fail("Editor file input not found.");
    await (input as { uploadFile: (...p: string[]) => Promise<void> }).uploadFile(FIXTURE_PATH);
    await page.waitForSelector('img[alt="Page 1"]', { timeout: 20_000 });

    // 1b. Density control: single page ↔ multi-column browse grid, then back.
    const gridBtn = await page.$('button[aria-label="3-column grid"]');
    if (!gridBtn) fail("Density grid control not found.");
    await gridBtn.click();
    await page.waitForSelector('button[aria-label="Open page 1"]', { timeout: 10_000 });
    const singleBtn = await page.$('button[aria-label="Single page"]');
    if (!singleBtn) fail("Density single-page control not found.");
    await singleBtn.click();
    await page.waitForSelector('img[alt="Page 1"]', { timeout: 10_000 });
    console.log("  ✓ density control (single ↔ grid)");

    // 2. Redact (destructive-drag): select tool, draw a box, apply the burn.
    const redactBtn = await page.$('button[aria-label="Redact"]');
    if (!redactBtn) fail("Redact rail tool not found.");
    await redactBtn.click();
    await waitForText(page, /Detect & add boxes/i, 5_000);
    await drawOnPage(page, { x: 0.25, y: 0.3 }, { x: 0.6, y: 0.45 });
    await waitForText(page, /\b1 redaction\b/, 5_000);
    if (!(await clickByText(page, "Apply 1 redaction"))) fail("Redact Apply button not found.");
    await waitForText(page, /\b0 redactions\b/, 60_000); // burn drops the box; rebuild re-renders
    console.log("  ✓ redact draw + destructive apply");

    // 3. Annotate (overlay-object): select tool, draw a pen stroke.
    const annBtn = await page.$('button[aria-label="Annotate"]');
    if (!annBtn) fail("Annotate rail tool not found.");
    await annBtn.click();
    await waitForText(page, /Apply annotations/i, 5_000);
    await drawOnPage(page, { x: 0.3, y: 0.5 }, { x: 0.7, y: 0.65 });
    await waitForText(page, /\b1 mark\b/, 5_000);
    console.log("  ✓ annotate draw");

    // 3b. Crop (drag a keep rect → per-page crop boxes). Page count unchanged.
    const cropBtn = await page.$('button[aria-label="Crop"]');
    if (!cropBtn) fail("Crop rail tool not found.");
    await cropBtn.click(); // focus mode
    await waitForText(page, /area to keep/i, 5_000);
    await drawOnPage(page, { x: 0.12, y: 0.1 }, { x: 0.9, y: 0.85 });
    await waitForText(page, /Keeping/i, 5_000);
    if (!(await clickByText(page, "Crop pages"))) fail("Crop Apply button not found.");
    await waitForText(page, /Working/i, 10_000);
    await waitForText(page, /area to keep/i, 60_000); // keep resets once applied
    await page.waitForSelector('img[alt="Page 1"]', { timeout: 10_000 });
    console.log("  ✓ crop drag + apply");

    // 3c. Signature (canvas placement): draw on pad → tap page → embed.
    const sigBtn = await page.$('button[aria-label="Signature"]');
    if (!sigBtn) fail("Signature rail tool not found.");
    await sigBtn.click(); // focus mode
    await waitForText(page, /Draw or upload a signature/i, 5_000);
    await scribbleOnPad(page);
    await waitForText(page, /Tap the page to place/i, 5_000);
    await clickOnPage(page, 0.5, 0.55);
    await waitForText(page, /\b1 signature\b/, 5_000);
    if (!(await clickByText(page, "Apply signature"))) fail("Signature Apply button not found.");
    await waitForText(page, /\b0 signatures\b/, 60_000); // embed drops the placed object
    console.log("  ✓ signature place + apply");

    // 4. OCR panel mounts + is wired (we don't run the engine — that would
    //    download model weights; just assert the desktop controls render).
    const ocrBtn = await page.$('button[aria-label="OCR"]');
    if (!ocrBtn) fail("OCR rail tool not found.");
    await ocrBtn.click();
    await waitForText(page, /Extract text/i, 5_000); // phase 1; engine not run here
    console.log("  ✓ OCR panel mounts (engine not run)");

    // 5. Organize (page-board): delete a page, apply via assemblePdf (40 → 39).
    const orgBtn = await page.$('button[aria-label="Organize"]');
    if (!orgBtn) fail("Organize rail tool not found.");
    await orgBtn.click(); // switches to overview + editable board
    await page.waitForSelector('button[aria-label="Delete page 1"]', { timeout: 10_000 });
    await page.click('button[aria-label="Delete page 1"]');
    if (!(await clickByText(page, "Apply changes"))) fail("Organize Apply button not found.");
    await waitForText(page, /\b39 pages\b/, 60_000);
    console.log("  ✓ organize delete + apply (40 → 39 pages)");

    // 6. Browse overview (deselect tool) + jump back to focus.
    await orgBtn.click(); // toggle organize off → read-only browse grid
    await page.waitForSelector('button[aria-label="Open page 1"]', { timeout: 10_000 });
    const pageButtons = await page.$$('button[aria-label^="Open page "]');
    if (pageButtons.length < 2) fail(`Expected ≥2 pages in overview, got ${pageButtons.length}.`);
    await page.click('button[aria-label="Open page 2"]');
    await page.waitForSelector('img[alt="Page 2"]', { timeout: 10_000 });

    // 7. Whole-doc options tool: flatten applies through the shared panel.
    const flattenBtn = await page.$('button[aria-label="Flatten"]');
    if (!flattenBtn) fail("Flatten rail tool not found.");
    await flattenBtn.click(); // mode "either" → stays in focus
    await waitForText(page, /Flatten document/i, 5_000);
    if (!(await clickByText(page, "Flatten document"))) fail("Flatten Apply button not found.");
    await waitForText(page, /Working/i, 10_000); // busy overlay / button
    await waitForText(page, /Flatten document/i, 60_000); // restored when done
    await page.waitForSelector('img[alt="Page 2"]', { timeout: 10_000 });
    console.log("  ✓ whole-doc apply (flatten)");

    // 8. Security panels load their async report on open.
    const metaBtn = await page.$('button[aria-label="Metadata"]');
    if (!metaBtn) fail("Metadata rail tool not found.");
    await metaBtn.click();
    await waitForText(page, /Save metadata/i, 10_000);
    const scrubBtn = await page.$('button[aria-label="Scrub"]');
    if (!scrubBtn) fail("Scrub rail tool not found.");
    await scrubBtn.click();
    await waitForText(page, /Scrub hidden data/i, 10_000);
    console.log("  ✓ metadata + scrub panels load");

    // 9. Merged Organize quick actions (absorbed reverse / extract / blank).
    //    Organize is the single page-board now — assert the quick actions
    //    render and the absorbed blank-scan runs to a result (no apply).
    await orgBtn.click(); // back into the page-board
    await waitForText(page, /Quick actions/i, 10_000);
    await waitForText(page, /Reverse order/i, 5_000);
    if (!(await clickByText(page, "Find blank pages"))) fail("Find blank pages action not found.");
    await waitForText(page, /No blank pages found|Delete \d+ blank page/i, 60_000);
    await orgBtn.click(); // toggle back off
    console.log("  ✓ merged organize (reverse/extract/blank quick actions)");

    // 10. Stamp-family option tool: page numbers applies via the option panel.
    const pnBtn = await page.$('button[aria-label="Page numbers"]');
    if (!pnBtn) fail("Page numbers rail tool not found.");
    await pnBtn.click();
    await waitForText(page, /Add page numbers/i, 5_000);
    if (!(await clickByText(page, "Add page numbers"))) fail("Page numbers Apply not found.");
    await waitForText(page, /Working/i, 10_000);
    await waitForText(page, /Add page numbers/i, 60_000);
    console.log("  ✓ stamp-family apply (page numbers)");

    // 11. Fill form: the fixture has no AcroForm, so the reader reports it.
    const formBtn = await page.$('button[aria-label="Fill form"]');
    if (!formBtn) fail("Fill form rail tool not found.");
    await formBtn.click();
    await waitForText(page, /no fillable form fields/i, 10_000);
    console.log("  ✓ fill-form reads fields (empty)");

    // 12. Bookmarks: add one row + apply, page count unchanged.
    const bmBtn = await page.$('button[aria-label="Bookmarks"]');
    if (!bmBtn) fail("Bookmarks rail tool not found.");
    await bmBtn.click();
    await waitForText(page, /show in the viewer's outline/i, 5_000);
    await page.type('input[placeholder="Bookmark title"]', "Intro");
    if (!(await clickByText(page, "Add 1 bookmark"))) fail("Bookmarks Apply button not found.");
    await waitForText(page, /Working/i, 10_000);
    await waitForText(page, /Add 1 bookmark/i, 60_000);
    console.log("  ✓ bookmarks add + apply");

    // 13. Attachments: list panel loads its async report on open.
    const attBtn = await page.$('button[aria-label="Attachments"]');
    if (!attBtn) fail("Attachments rail tool not found.");
    await attBtn.click();
    await waitForText(page, /No files attached yet|Reading attachments/i, 10_000);
    console.log("  ✓ attachments panel loads");

    if (errors.length > 0) {
      console.error("✗ Console/page errors during smoke:");
      for (const e of errors) console.error(`   ${e}`);
      process.exit(1);
    }

    console.log(
      `✓ Editor smoke passed — redact burn, annotate, crop, signature, organize (now ${pageButtons.length} pages), overview/focus, stamps, forms, bookmarks, attachments, OCR wired.`,
    );
  } catch (e) {
    console.error(`✗ Smoke failed: ${e instanceof Error ? e.message : String(e)}`);
    if (errors.length) {
      console.error("Console errors:");
      for (const x of errors) console.error(`   ${x}`);
    }
    try {
      await page.screenshot({ path: "/tmp/editor-smoke-fail.png" });
      console.error("screenshot → /tmp/editor-smoke-fail.png");
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

void main();
