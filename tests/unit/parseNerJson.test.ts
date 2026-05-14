/**
 * Tests for `parseNerJson` — the defensive parser sitting between the
 * LLM's free-text reply and the Detect PII tool's entity list.
 *
 * Why this matters: small instruction-tuned models often follow the
 * "JSON array only, no preamble" instruction *almost* but not quite.
 * If the parser throws on any imperfection, a single noisy chunk
 * tanks the whole scan. These tests pin the contract: extract what
 * we can, drop what's malformed, never throw.
 */
import { describe, expect, it } from "vitest";
import { parseNerJson } from "../../src/utils/ai-tasks.ts";

describe("parseNerJson", () => {
  it("parses a clean JSON array", () => {
    const reply = '[{"text":"John Smith","type":"PER"},{"text":"Acme Corp","type":"ORG"}]';
    expect(parseNerJson(reply)).toEqual([
      { text: "John Smith", type: "PER" },
      { text: "Acme Corp", type: "ORG" },
    ]);
  });

  it("extracts the array when prefixed with conversational prose", () => {
    const reply =
      'Sure! Here are the entities I found:\n[{"text":"Berlin","type":"LOC"}]\nLet me know if you need more.';
    expect(parseNerJson(reply)).toEqual([{ text: "Berlin", type: "LOC" }]);
  });

  it("extracts the array when wrapped in a fenced code block", () => {
    const reply = '```json\n[{"text":"OpenAI","type":"ORG"}]\n```';
    expect(parseNerJson(reply)).toEqual([{ text: "OpenAI", type: "ORG" }]);
  });

  it("returns [] when no array is present", () => {
    expect(parseNerJson("I could not find any entities.")).toEqual([]);
    expect(parseNerJson("")).toEqual([]);
  });

  it("returns [] for malformed JSON without throwing", () => {
    expect(parseNerJson("[not valid json")).toEqual([]);
    expect(parseNerJson("[{text: missing quotes}]")).toEqual([]);
  });

  it("drops items missing required fields", () => {
    const reply = '[{"text":"OK","type":"PER"},{"text":"NoType"},{"type":"PER"},{}]';
    expect(parseNerJson(reply)).toEqual([{ text: "OK", type: "PER" }]);
  });

  it("drops items with wrong field types", () => {
    const reply = '[{"text":"OK","type":"PER"},{"text":123,"type":"PER"},{"text":"OK2","type":42}]';
    expect(parseNerJson(reply)).toEqual([{ text: "OK", type: "PER" }]);
  });

  it("uppercases the type field — accepts lowercase model output", () => {
    const reply = '[{"text":"London","type":"loc"},{"text":"Sumit","type":"per"}]';
    expect(parseNerJson(reply)).toEqual([
      { text: "London", type: "LOC" },
      { text: "Sumit", type: "PER" },
    ]);
  });

  it("rejects entity types outside PER/ORG/LOC/MISC", () => {
    const reply =
      '[{"text":"foo@bar.com","type":"EMAIL"},{"text":"$100","type":"MONEY"},{"text":"Jane","type":"PER"}]';
    expect(parseNerJson(reply)).toEqual([{ text: "Jane", type: "PER" }]);
  });

  it("trims whitespace from the surface form", () => {
    const reply = '[{"text":"  Padded Name  ","type":"PER"}]';
    expect(parseNerJson(reply)).toEqual([{ text: "Padded Name", type: "PER" }]);
  });

  it("drops items with empty text after trim", () => {
    const reply =
      '[{"text":"   ","type":"PER"},{"text":"","type":"PER"},{"text":"Real","type":"PER"}]';
    expect(parseNerJson(reply)).toEqual([{ text: "Real", type: "PER" }]);
  });

  it("leniently digs the array out of an object wrapper", () => {
    // Some models wrap the array under an "entities" key. The
    // first-'[' / last-']' slice happens to extract the inner array
    // correctly here — a useful accident we lock in as behavior.
    const reply = '{"entities":[{"text":"X","type":"PER"}]}';
    expect(parseNerJson(reply)).toEqual([{ text: "X", type: "PER" }]);
  });

  it("returns [] when prose contains brackets that confuse the slice (known limitation)", () => {
    // first '[' is in "[redacted...", last ']' is in "[end]". The
    // span between them is not valid JSON, so JSON.parse fails and
    // we return [] rather than throw. Acceptable because our prompt
    // tells the model "return ONLY the JSON array, no preamble".
    const reply =
      'Entities [redacted for privacy] are:\n[{"text":"Alice","type":"PER"}]\nThanks [end]';
    expect(parseNerJson(reply)).toEqual([]);
  });

  it("tolerates extra whitespace and newlines around items", () => {
    const reply = `[
      { "text": "Multi-line",  "type": "PER" },
      { "text": "Format",      "type": "ORG" }
    ]`;
    expect(parseNerJson(reply)).toEqual([
      { text: "Multi-line", type: "PER" },
      { text: "Format", type: "ORG" },
    ]);
  });
});
