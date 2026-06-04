/**
 * End-to-end smoke for the M3c multi-file constructor → editor hand-off.
 *
 * Merge and Images-to-PDF produce one PDF with no single source file to edit in
 * place, so they hand their output to the canvas editor (OPEN_EDITOR_EVENT →
 * App routes to {kind:"editor"}). This drives the Merge path in a real browser:
 *   home → Merge PDFs card → drop 2 PDFs → "Merge 2 files & edit" → editor opens.
 *
 * Requirements: Chrome at CHROME_PATH and the dev server at http://localhost:5173.
 * Run:  node --experimental-strip-types tests/e2e/constructor-handoff.ts
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

    // Home → Merge PDFs tool.
    if (!(await clickByText(page, "Merge PDFs"))) fail("'Merge PDFs' tool card not found.");
    await page.waitForSelector("input[type=file]", { timeout: 15_000 });
    const input = await page.$("input[type=file]");
    if (!input) fail("Merge file input not found.");

    // Drop two PDFs. The drop handler runs an async per-file encryption check,
    // so the merge action appears a tick later — wait for it.
    await (input as { uploadFile: (...p: string[]) => Promise<void> }).uploadFile(
      FIXTURE_A,
      FIXTURE_B,
    );
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

    // Hand-off lands in the editor: the focus page renders.
    await page.waitForSelector('img[alt="Page 1"]', { timeout: 30_000 });
    console.log("  ✓ merge → editor hand-off (focus page rendered)");

    if (errors.length > 0) {
      console.error("✗ Console/page errors during hand-off:");
      for (const e of errors) console.error(`   ${e}`);
      process.exit(1);
    }
    console.log("✓ Constructor hand-off smoke passed — Merge output opens in the editor.");
  } catch (e) {
    console.error(`✗ Hand-off smoke failed: ${e instanceof Error ? e.message : String(e)}`);
    try {
      await page.screenshot({ path: "/tmp/constructor-handoff-fail.png" });
      console.error("screenshot → /tmp/constructor-handoff-fail.png");
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

void main();
