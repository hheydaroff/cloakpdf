/**
 * End-to-end smoke for the M4 editor-first home routing.
 *
 * Two behaviours the home now owns:
 *   1. Editor-eligible tool cards open the canvas editor with that tool
 *      preselected (click "Redact" → editor → drop a PDF → Redact already live).
 *   2. The multi-file constructors hand their output to the editor (M3c):
 *      Merge → drop 2 PDFs → "Merge 2 files & edit" → editor opens on the result.
 *
 * Requirements: Chrome at CHROME_PATH and the dev server at http://localhost:5173.
 * Run:  node --experimental-strip-types tests/e2e/home-routing.ts
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launch } from "puppeteer-core";

const DEV_URL = process.env.E2E_URL ?? "http://localhost:5173";
const CHROME_PATH =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FIXTURE_A = resolve(import.meta.dirname, "../fixtures/sample.pdf");
const FIXTURE_B = resolve(import.meta.dirname, "../fixtures/multipage.pdf");

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!existsSync(CHROME_PATH)) fail(`Chrome not found at ${CHROME_PATH} (set CHROME_PATH).`);
if (!existsSync(FIXTURE_A) || !existsSync(FIXTURE_B)) fail("Fixtures missing.");

/** Click the first card/button whose heading or text equals `label`. */
async function clickByText(page: Page, label: string): Promise<boolean> {
  return page.evaluate((text) => {
    const els = Array.from(document.querySelectorAll("button, a, [role=button]"));
    const el = els.find((e) => {
      const head = e.querySelector("h3")?.textContent ?? e.textContent ?? "";
      return head.trim().toLowerCase() === text.toLowerCase();
    });
    if (!el) return false;
    (el as HTMLElement).click();
    return true;
  }, label);
}

/** Wait until the page's visible text matches `re` (flags preserved). */
async function waitForText(page: Page, re: RegExp, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    (src: string, flags: string) => new RegExp(src, flags).test(document.body.innerText),
    { timeout },
    re.source,
    re.flags,
  );
}

async function uploadInto(page: Page, ...fixtures: string[]): Promise<void> {
  await page.waitForSelector("input[type=file]", { timeout: 15_000 });
  const input = await page.$("input[type=file]");
  if (!input) fail("File input not found.");
  await (input as { uploadFile: (...p: string[]) => Promise<void> }).uploadFile(...fixtures);
}

async function main() {
  const errors: string[] = [];
  const browser = await launch({
    executablePath: CHROME_PATH,
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

    // 1. Editor-eligible card → editor with the tool preselected. Clicking the
    //    "Redact" card opens the empty editor; after a PDF loads, the Redact
    //    panel is already active WITHOUT touching the rail.
    if (!(await clickByText(page, "Redact PDF"))) fail("'Redact PDF' tool card not found.");
    await uploadInto(page, FIXTURE_A);
    await page.waitForSelector('img[alt="Page 1"]', { timeout: 30_000 });
    await waitForText(page, /Detect & add boxes/i, 10_000);
    console.log("  ✓ editor card routing (Redact preselected)");

    // 2. Constructor hand-off: back home, merge two PDFs, land in the editor.
    await page.goto(DEV_URL, { waitUntil: "networkidle2" });
    if (!(await clickByText(page, "Merge PDFs"))) fail("'Merge PDFs' tool card not found.");
    await uploadInto(page, FIXTURE_A, FIXTURE_B);
    await page
      .waitForFunction(
        () =>
          Array.from(document.querySelectorAll("button")).some((b) =>
            (b.textContent ?? "").includes("Merge 2 files"),
          ),
        { timeout: 15_000 },
      )
      .catch(() => fail("'Merge 2 files & edit' button did not appear after dropping 2 PDFs."));
    const clicked = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find((x) =>
        (x.textContent ?? "").includes("Merge 2 files"),
      );
      if (!b) return false;
      (b as HTMLElement).click();
      return true;
    });
    if (!clicked) fail("Merge action button vanished before click.");
    await page.waitForSelector('img[alt="Page 1"]', { timeout: 30_000 });
    console.log("  ✓ merge → editor hand-off (focus page rendered)");

    if (errors.length > 0) {
      console.error("✗ Console/page errors during home routing:");
      for (const e of errors) console.error(`   ${e}`);
      process.exit(1);
    }
    console.log("✓ Home routing smoke passed — editor-card preselect + constructor hand-off.");
  } catch (e) {
    console.error(`✗ Home routing smoke failed: ${e instanceof Error ? e.message : String(e)}`);
    try {
      await page.screenshot({ path: "/tmp/home-routing-fail.png" });
      console.error("screenshot → /tmp/home-routing-fail.png");
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

void main();
