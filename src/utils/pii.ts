/**
 * Deterministic PII detection — the shared, single source of truth for
 * personally-identifiable patterns across the app.
 *
 * Two consumers with different needs:
 *
 *   - **Ask PDF fast-paths** ([src/rag/fast-paths.ts]) want a *single,
 *     header-biased* match to answer "what's their email/phone?" verbatim.
 *     They import the narrow {@link EMAIL_RE} / {@link PHONE_RE} below and use
 *     them non-globally (`.match` / `.test`) exactly as before — moving them
 *     here is a pure relocation, no behaviour change.
 *
 *   - **Smart redaction** wants to *sweep the whole page* for every PII span
 *     with character offsets, so {@link detectPii} runs a broader pattern set
 *     with fresh global regexes (own `lastIndex`, so the two never interfere)
 *     and resolves overlaps by specificity.
 *
 * No model, no network — pure regex (+ a Luhn check for card numbers). Person
 * *names* are deliberately NOT detected: reliable name detection needs an NER
 * model, which would force the redaction tool desktop-only; users box names
 * by hand. Everything here is reviewed by the user before anything is burned
 * into the PDF.
 */

// ── narrow patterns shared with the RAG fast-paths (do not change) ──────────

/**
 * Phone-number regex used by the Ask-PDF contact fast-path: an international
 * `+CC NNNN…` form, a `(NNN) NNN-NNNN` form, or any plain run of 7+ digits.
 * Intentionally loose and **non-global** — `fast-paths.ts` relies on first-match
 * `.match()` / stateless `.test()`. The redaction sweep uses its own, tighter
 * pattern (see PATTERNS.phone) so this one's looseness can't add noise there.
 */
export const PHONE_RE =
  /\+\d{1,3}[\s\-.]?\d[\d\s\-.()]{5,}\d|\(?\d{3}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{4}|\b\d{7,}\b/;

/** Email regex. Standard local-part / domain shape. Shared with the fast-paths. */
export const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

// ── detection taxonomy ──────────────────────────────────────────────────────

export type PiiType = "email" | "phone" | "ssn" | "credit-card" | "iban" | "ip" | "date";

export interface PiiMatch {
  type: PiiType;
  /** The matched substring. */
  value: string;
  /** Inclusive start offset in the source text. */
  start: number;
  /** Exclusive end offset in the source text. */
  end: number;
}

/** All detectable types, in the order a UI should present them. */
export const PII_TYPES: PiiType[] = ["email", "phone", "ssn", "credit-card", "iban", "ip", "date"];

/** Human labels for the UI. */
export const PII_LABELS: Record<PiiType, string> = {
  email: "Email",
  phone: "Phone",
  ssn: "SSN",
  "credit-card": "Credit card",
  iban: "IBAN",
  ip: "IP address",
  date: "Date",
};

/**
 * Source patterns for the page sweep. These are intentionally *separate* from
 * the narrow fast-path regexes: tuned for recall across a whole document with
 * false positives bounded by (a) the Luhn check on cards and (b) overlap
 * resolution in {@link detectPii}. The user reviews every hit before redacting.
 */
const PATTERNS: Record<PiiType, RegExp> = {
  email: EMAIL_RE,
  // International "+CC …" run, or a separated domestic number (needs ≥2 groups,
  // so bare ID runs like "12345678" don't match here).
  phone: /\+\d[\d\s\-.()]{6,}\d|(?:\(\d{1,4}\)[\s\-.]?)?\d{2,4}(?:[\s\-.]\d{2,4}){1,4}/,
  // US SSN, dashed or spaced.
  ssn: /\b\d{3}[\s-]\d{2}[\s-]\d{4}\b/,
  // 13–19 digits, optionally grouped by spaces/hyphens (Luhn-checked in detectPii).
  "credit-card": /\b(?:\d[ -]?){13,19}\b/,
  // IBAN: 2-letter country + 2 check digits + 11–30 alphanumerics (grouped).
  iban: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/,
  // IPv4, or a basic full-form IPv6.
  ip: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b|\b(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}\b/,
  // ISO, numeric d/m/y, or "Month DD, YYYY".
  date: /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/,
};

/** Lower number = more specific; wins when two matches overlap. */
const PRIORITY: Record<PiiType, number> = {
  email: 0,
  iban: 1,
  "credit-card": 2,
  ssn: 3,
  ip: 4,
  phone: 5,
  date: 6,
};

/** Luhn checksum — filters out digit runs that aren't valid card numbers. */
export function isLuhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export interface DetectPiiOptions {
  /** Restrict to these types. Defaults to all of {@link PII_TYPES}. */
  types?: PiiType[];
}

/**
 * Find every PII span in `text`, with character offsets, de-overlapped.
 *
 * For each requested type we run a fresh global regex (own `lastIndex`, so we
 * never disturb the shared fast-path regexes), drop invalid card numbers via
 * Luhn, then resolve overlaps: when two matches cover the same characters the
 * more specific / longer one wins (e.g. an email isn't also reported as a
 * date, a card isn't also reported as a phone). Results are returned sorted by
 * position.
 */
export function detectPii(text: string, options: DetectPiiOptions = {}): PiiMatch[] {
  const types = options.types ?? PII_TYPES;
  const raw: PiiMatch[] = [];

  for (const type of types) {
    const base = PATTERNS[type];
    const re = new RegExp(base.source, base.flags.includes("g") ? base.flags : `${base.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (type === "credit-card" && !isLuhnValid(m[0])) continue;
      // Phone numbers have ≥7 digits — this drops decimal amounts ("$93.50"),
      // version strings and the like that the separated pattern otherwise grabs.
      if (type === "phone" && m[0].replace(/\D/g, "").length < 7) continue;
      raw.push({ type, value: m[0], start: m.index, end: m.index + m[0].length });
    }
  }

  // Sort by start, then specificity, then length — and greedily keep
  // non-overlapping matches so each character is claimed by one type.
  raw.sort(
    (a, b) =>
      a.start - b.start ||
      PRIORITY[a.type] - PRIORITY[b.type] ||
      b.end - b.start - (a.end - a.start),
  );
  const accepted: PiiMatch[] = [];
  for (const match of raw) {
    if (accepted.some((a) => a.start < match.end && match.start < a.end)) continue;
    accepted.push(match);
  }
  return accepted.sort((a, b) => a.start - b.start);
}
