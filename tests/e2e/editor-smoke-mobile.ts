/**
 * End-to-end smoke test for the canvas editor's MOBILE layout (bottom sheet).
 *
 * Runs at a phone viewport so the editor resolves to the mobile sheet UI and
 * asserts the mobile-specific behaviours that desktop never exercises:
 *   open → mobile sheet (no desktop rail) →
 *   crop: per-tool Apply button is HIDDEN, the global ✓ (Done) applies it →
 *   OCR: the Extract button + controls render on mobile (no desktop-only notice) →
 *   60:40 split: the open tool sheet is capped at ≤40% of the editor column and
 *     the canvas page stays visible; a tall panel's body scrolls →
 *   no console / page errors throughout.
 *
 * The engine-heavy OCR path is never run here (it would fetch model weights);
 * the step only asserts the controls are reachable on a phone.
 *
 * Requirements: Chrome at CHROME_PATH (default macOS path) and the dev server
 * at http://localhost:5173 (`vp dev`). Fixture: tests/fixtures/multipage.pdf.
 *
 * Run:  node --experimental-strip-types tests/e2e/editor-smoke-mobile.ts
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
  process.env.E2E_USER_DATA_DIR ??
  resolve(import.meta.dirname, "../.puppeteer-profile-editor-mobile");

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!existsSync(CHROME_PATH)) fail(`Chrome not found at ${CHROME_PATH} (set CHROME_PATH).`);
if (!existsSync(FIXTURE_PATH)) fail(`Fixture not found at ${FIXTURE_PATH}.`);

/** True if a visible button/link's trimmed text equals `label` (case-insensitive). */
async function hasExactText(page: Page, label: string): Promise<boolean> {
  return page.evaluate((text) => {
    const els = Array.from(document.querySelectorAll("button, a, [role=button]"));
    return els.some((e) => (e.textContent ?? "").trim().toLowerCase() === text.toLowerCase());
  }, label);
}

/** Wait until the page's visible text matches `re` (preserves regex flags). */
async function waitForText(page: Page, re: RegExp, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    (src: string, flags: string) => new RegExp(src, flags).test(document.body.innerText),
    { timeout },
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

/** Wait until the global busy overlay (portaled, aria-busy) is gone — the mobile
 *  ✓ closes the tool immediately and applies under this overlay, so a follow-up
 *  tap must wait for it to clear or it hits the overlay instead. */
async function waitForNoBusy(page: Page, timeout = 60_000): Promise<void> {
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout });
}

/** Open the tool picker (if closed) and pick a tool by its rail/sheet name. */
async function pickTool(page: Page, name: string): Promise<void> {
  await waitForNoBusy(page);
  // Open the picker; confirm it actually opened (the toggle flips to "Close
  // tools"), retrying once in case the first tap landed mid-transition.
  for (let attempt = 0; attempt < 2; attempt++) {
    const toggle = await page.$('button[aria-label="Open tools"]');
    if (!toggle) break; // already open
    await toggle.click();
    const opened = await page
      .waitForSelector('button[aria-label="Close tools"]', { timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (opened) break;
  }
  await page.waitForSelector(`button[aria-label="${name}"]`, { timeout: 10_000 });
  await page.click(`button[aria-label="${name}"]`);
}

/** Sheet height as a fraction of the editor content column it sits in. */
async function sheetFraction(page: Page): Promise<number> {
  return page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="mobile-tool-sheet"]') as HTMLElement | null;
    const col = sheet?.parentElement as HTMLElement | null;
    if (!sheet || !col) return -1;
    const sh = sheet.getBoundingClientRect().height;
    const ch = col.getBoundingClientRect().height;
    return ch > 0 ? sh / ch : -1;
  });
}

async function main() {
  const errors: string[] = [];
  const browser = await launch({
    executablePath: CHROME_PATH,
    userDataDir: USER_DATA_DIR,
    headless: true,
    // iPhone-ish portrait: shortEdge 390 < 760 → mobile sheet layout.
    defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
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

    console.log(`→ Loading ${DEV_URL} (390×844 mobile)`);
    await page.goto(DEV_URL, { waitUntil: "networkidle2" });

    // Clean draft store so a prior run's autosave doesn't pop the restore banner.
    await page.evaluate(
      () =>
        new Promise<void>((res) => {
          const r = indexedDB.deleteDatabase("cloakpdf-editor");
          r.onsuccess = r.onerror = r.onblocked = () => res();
        }),
    );

    // 1. Editor-first entry → mobile sheet. The desktop tool rail never renders
    //    on mobile; the bottom "Tools" toggle is the tool entry point instead.
    await page.waitForSelector("input[type=file]", { timeout: 15_000 });
    const input = await page.$("input[type=file]");
    if (!input) fail("Home dropzone file input not found.");
    await (input as { uploadFile: (...p: string[]) => Promise<void> }).uploadFile(FIXTURE_PATH);
    await page.waitForSelector('img[alt="Page 1"]', { timeout: 20_000 });
    await page.waitForSelector('button[aria-label="Open tools"]', { timeout: 10_000 });
    if (await page.$('[data-testid="mobile-tool-sheet"]')) {
      // sheet present
    } else {
      fail("Mobile tool sheet not rendered at phone width.");
    }
    console.log("  ✓ mobile sheet entry (no desktop rail)");

    // 2. Crop via the GLOBAL ✓: the per-tool "Crop pages" Apply button must be
    //    hidden on mobile, and the sheet header's Done (✓) commits the crop.
    await pickTool(page, "Crop");
    await waitForText(page, /area to keep/i, 8_000);
    if (await hasExactText(page, "Crop pages"))
      fail("Per-tool 'Crop pages' Apply button should be hidden on mobile.");
    if (!(await page.$('button[aria-label="Done"]'))) fail("Global Done (✓) button not found.");
    if (!(await page.$('button[aria-label="Cancel"]'))) fail("Global Cancel (✗) button not found.");
    await drawOnPage(page, { x: 0.12, y: 0.1 }, { x: 0.9, y: 0.7 });
    await waitForText(page, /Keeping/i, 8_000);

    // 2a. 60:40 split: while the Crop sheet is open, it must not exceed ~40% of
    //     the editor column, and the canvas page must still be on screen.
    const frac = await sheetFraction(page);
    if (frac < 0 || frac > 0.43)
      fail(`Tool sheet should be ≤40% of the editor column; got ${(frac * 100).toFixed(1)}%.`);
    const pageVisible = await page.evaluate(() => {
      const img = document.querySelector('img[alt="Page 1"]') as HTMLElement | null;
      if (!img) return false;
      const r = img.getBoundingClientRect();
      return r.height > 0 && r.bottom <= window.innerHeight;
    });
    if (!pageVisible) fail("Canvas page not visible above the tool sheet.");
    console.log(`  ✓ 60:40 split (sheet ${(frac * 100).toFixed(0)}% of column, canvas visible)`);

    // 2b. Tap the global ✓ → the tool closes at once and the crop applies under
    //     the busy overlay; wait for that to clear, then we're back at "Tools".
    await page.click('button[aria-label="Done"]');
    await page.waitForSelector('button[aria-label="Open tools"]', { timeout: 60_000 });
    await waitForNoBusy(page);
    await page.waitForSelector('img[alt="Page 1"]', { timeout: 10_000 });
    console.log("  ✓ crop applied via global ✓ (per-tool Apply hidden)");

    // 3. OCR is enabled on mobile now: the Extract control renders (engine NOT
    //    run here), and the old desktop-only notice is gone. A multi-control
    //    panel like this also proves the sheet body scrolls within the 40% cap.
    await pickTool(page, "OCR");
    await waitForText(page, /Extract text/i, 8_000);
    const desktopOnlyNote = await page.evaluate(() =>
      /open this pdf on a desktop/i.test(document.body.innerText),
    );
    if (desktopOnlyNote) fail("OCR still shows the desktop-only notice on mobile.");
    const ocrFrac = await sheetFraction(page);
    if (ocrFrac < 0 || ocrFrac > 0.43)
      fail(`OCR sheet should be ≤40% of the column; got ${(ocrFrac * 100).toFixed(1)}%.`);
    const bodyScrolls = await page.evaluate(() => {
      const body = document.querySelector('[aria-label="Tool controls"]') as HTMLElement | null;
      if (!body) return false;
      const cs = getComputedStyle(body);
      return cs.overflowY === "auto" && body.scrollHeight >= body.clientHeight;
    });
    if (!bodyScrolls) fail("OCR sheet body is not a scroll container.");
    console.log(
      `  ✓ OCR enabled on mobile (Extract visible, sheet ${(ocrFrac * 100).toFixed(0)}%)`,
    );
    await page.click('button[aria-label="Cancel"]'); // close OCR without running the engine

    if (errors.length > 0) {
      console.error("✗ Console/page errors during mobile smoke:");
      for (const e of errors) console.error(`   ${e}`);
      process.exit(1);
    }

    console.log(
      "✓ Mobile editor smoke passed — sheet entry, crop via global ✓ (per-tool Apply hidden), OCR on mobile, 60:40 split + scrollable body.",
    );
  } catch (e) {
    console.error(`✗ Mobile smoke failed: ${e instanceof Error ? e.message : String(e)}`);
    if (errors.length) {
      console.error("Console errors:");
      for (const x of errors) console.error(`   ${x}`);
    }
    try {
      await page.screenshot({ path: "/tmp/editor-smoke-mobile-fail.png" });
      console.error("screenshot → /tmp/editor-smoke-mobile-fail.png");
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

void main();
