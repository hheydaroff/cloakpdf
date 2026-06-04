/**
 * End-to-end smoke test for the canvas editor (M0 scaffold).
 *
 * Unlike `ai-tools.e2e.ts` this downloads NO model weights — it just drives the
 * editor's open → render → navigate → mode-switch → tool-select happy path in a
 * real browser and asserts the chrome mounts without console errors.
 *
 * Requirements: Chrome at CHROME_PATH (default macOS path) and the dev server
 * at http://localhost:5173 (`vp dev`). Fixture: tests/fixtures/multipage.pdf.
 *
 * Run:  node --experimental-strip-types tests/e2e/editor-smoke.ts
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
async function clickByText(page: import("puppeteer-core").Page, label: string): Promise<boolean> {
  return page.evaluate((text) => {
    const els = Array.from(document.querySelectorAll("button, a, [role=button]"));
    const el = els.find((e) => (e.textContent ?? "").trim().toLowerCase() === text.toLowerCase());
    if (!el) return false;
    (el as HTMLElement).click();
    return true;
  }, label);
}

async function main() {
  const errors: string[] = [];
  const browser = await launch({
    executablePath: CHROME_PATH,
    userDataDir: USER_DATA_DIR,
    headless: true,
    defaultViewport: { width: 1280, height: 900 },
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e: unknown) =>
      errors.push(`pageerror: ${e instanceof Error ? e.message : String(e)}`),
    );

    console.log(`→ Loading ${DEV_URL}`);
    await page.goto(DEV_URL, { waitUntil: "networkidle2" });

    // 1. Editor-first CTA opens the editor.
    if (!(await clickByText(page, "Open the editor"))) fail("'Open the editor' CTA not found.");

    // 2. Editor dropzone appears; upload the fixture.
    await page.waitForSelector("input[type=file]", { timeout: 15_000 });
    const input = await page.$("input[type=file]");
    if (!input) fail("Editor file input not found.");
    await (input as { uploadFile: (...p: string[]) => Promise<void> }).uploadFile(FIXTURE_PATH);

    // 3. Focus stage renders the first page.
    await page.waitForSelector('img[alt="Page 1"]', { timeout: 20_000 });
    const pageCountText = await page.evaluate(() => document.body.innerText);
    if (!/\bpages?\b/i.test(pageCountText)) fail("Page-count pill not shown.");

    // 4. Rail renders tools; selecting one shows its panel header.
    const railBtn = await page.$('button[aria-label="Redact"]');
    if (!railBtn) fail("Redact rail tool not found.");
    await railBtn.click();
    await page.waitForFunction(
      () => /This tool moves into the editor/i.test(document.body.innerText),
      { timeout: 5_000 },
    );

    // 5. Overview mode shows the page grid.
    if (!(await clickByText(page, "overview"))) fail("Overview toggle not found.");
    await page.waitForSelector('button[aria-label="Open page 1"]', { timeout: 10_000 });
    const pageButtons = await page.$$('button[aria-label^="Open page "]');
    if (pageButtons.length < 2) fail(`Expected ≥2 pages in overview, got ${pageButtons.length}.`);

    // 6. Clicking a page returns to focus mode on it.
    await page.click('button[aria-label="Open page 2"]');
    await page.waitForSelector('img[alt="Page 2"]', { timeout: 10_000 });

    if (errors.length > 0) {
      console.error("✗ Console/page errors during smoke:");
      for (const e of errors) console.error(`   ${e}`);
      process.exit(1);
    }

    console.log(
      `✓ Editor smoke passed — opened, rendered ${pageButtons.length} pages, navigated, switched modes, selected a tool.`,
    );
  } finally {
    await browser.close();
  }
}

void main();
