/**
 * Tests for `formatRawOutput`.
 *
 * IMPORTANT: `objectCache` (WeakMap) and `stringCache` (Map) are module-level
 * singletons that persist for the lifetime of the test file. To keep cases
 * independent each test uses fresh object references and unique string inputs
 * so cache state from one case never colours the next.
 *
 * The string cache eviction case intentionally fills `stringCache` past its
 * `STRING_CACHE_MAX` (64) limit. That test reserves its own keyspace prefix
 * (`evict-`) so it can't collide with other cases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRawOutput } from "./format-raw-output.ts";
import { jsonHighlighter } from "./json-highlighter.ts";

describe("formatRawOutput", () => {
  let codeToHtmlSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy without overriding implementation so we still get a real highlighted
    // string back. Tests assert on call counts + on the returned content.
    codeToHtmlSpy = vi.spyOn(jsonHighlighter, "codeToHtml");
  });

  afterEach(() => {
    codeToHtmlSpy.mockRestore();
  });

  it("returns a highlighted 'null' string for null input", () => {
    const result = formatRawOutput(null);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("null");
  });

  it("returns a highlighted 'undefined' string for undefined input", () => {
    const result = formatRawOutput(undefined);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("undefined");
  });

  it("hits the object WeakMap cache on the same reference", () => {
    const obj = { cacheHit: true, marker: "object-same-ref" };

    const first = formatRawOutput(obj);
    const callsAfterFirst = codeToHtmlSpy.mock.calls.length;
    const second = formatRawOutput(obj);
    const callsAfterSecond = codeToHtmlSpy.mock.calls.length;

    expect(first).toBe(second);
    // Highlighter should not have been called again — cache served the second.
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });

  it("misses the object cache for different references with identical content", () => {
    const a = { sameShape: 1, marker: "object-diff-ref-a" };
    const b = { sameShape: 1, marker: "object-diff-ref-b" };

    const callsBefore = codeToHtmlSpy.mock.calls.length;
    formatRawOutput(a);
    formatRawOutput(b);
    const callsAfter = codeToHtmlSpy.mock.calls.length;

    // Two distinct references, two highlighter invocations.
    expect(callsAfter - callsBefore).toBe(2);
  });

  it("hits the string cache on the same input string", () => {
    const input = '{"stringCacheHit":true,"marker":"string-same"}';

    const callsBefore = codeToHtmlSpy.mock.calls.length;
    const first = formatRawOutput(input);
    const callsAfterFirst = codeToHtmlSpy.mock.calls.length;
    const second = formatRawOutput(input);
    const callsAfterSecond = codeToHtmlSpy.mock.calls.length;

    expect(first).toBe(second);
    expect(callsAfterFirst - callsBefore).toBe(1);
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });

  it("evicts the oldest string-cache entry once the bounded FIFO passes 64", () => {
    const STRING_CACHE_MAX = 64;
    // Use VALID-JSON strings so each insertion actually invokes the highlighter
    // (the escapeHTML fallback never calls codeToHtml, which would make
    // call-count assertions meaningless).
    const makeKey = (i: number) => `{"evict":${i}}`;
    const firstKey = makeKey(0);

    // Seed the first key so we can observe whether it survives.
    const seedFirst = codeToHtmlSpy.mock.calls.length;
    formatRawOutput(firstKey);
    expect(codeToHtmlSpy.mock.calls.length - seedFirst).toBe(1);

    // Fill with 63 more unique strings; combined with `firstKey` that brings
    // the cache to exactly STRING_CACHE_MAX entries.
    for (let i = 1; i < STRING_CACHE_MAX; i++) {
      formatRawOutput(makeKey(i));
    }

    // A re-call of firstKey at this point should still hit the cache.
    const beforeMidCheck = codeToHtmlSpy.mock.calls.length;
    formatRawOutput(firstKey);
    expect(codeToHtmlSpy.mock.calls.length).toBe(beforeMidCheck);

    // Push past the limit — this triggers eviction of the OLDEST key
    // (firstKey, the first insertion).
    formatRawOutput(makeKey(STRING_CACHE_MAX));

    // Re-calling firstKey should now miss and re-invoke the highlighter.
    const beforeEvictCheck = codeToHtmlSpy.mock.calls.length;
    formatRawOutput(firstKey);
    expect(codeToHtmlSpy.mock.calls.length - beforeEvictCheck).toBe(1);
  });

  it("falls back to escaped String(value) for unstringifiable objects (circular ref)", () => {
    type Circular = { self?: Circular; marker: string; html: string };
    const circular: Circular = { marker: "circular-1", html: "<a>&b</a>" };
    circular.self = circular;

    const callsBefore = codeToHtmlSpy.mock.calls.length;
    const first = formatRawOutput(circular);
    const callsAfterFirst = codeToHtmlSpy.mock.calls.length;

    // JSON.stringify threw → highlighter never touched the value.
    expect(callsAfterFirst).toBe(callsBefore);

    // The fallback is `escapeHTML(String(value))`. `String({})` is
    // "[object Object]" which has no HTML-special chars, but the function
    // still routed through escapeHTML — assert the result is exactly that.
    expect(first).toBe("[object Object]");

    // Second call with the same circular ref should hit the WeakMap fallback
    // cache: no new highlighter calls, identical return.
    const second = formatRawOutput(circular);
    expect(codeToHtmlSpy.mock.calls.length).toBe(callsAfterFirst);
    expect(second).toBe(first);
  });

  it("escapes HTML-special characters when an unstringifiable object's String() form contains them", () => {
    // Custom toString so the fallback path has something to escape.
    const circular: { self?: unknown; toString: () => string } = {
      toString: () => "<tag>&amp;</tag>",
    };
    circular.self = circular; // make JSON.stringify throw

    const callsBefore = codeToHtmlSpy.mock.calls.length;
    const result = formatRawOutput(circular);
    const callsAfter = codeToHtmlSpy.mock.calls.length;

    expect(callsAfter).toBe(callsBefore);
    // `&` is escaped first → existing `&amp;` becomes `&amp;amp;`; then `<`/`>`.
    expect(result).toBe("&lt;tag&gt;&amp;amp;&lt;/tag&gt;");
  });

  it("HTML-escapes invalid JSON strings without invoking the highlighter", () => {
    const input = "not { valid <json> & stuff";

    const callsBefore = codeToHtmlSpy.mock.calls.length;
    const result = formatRawOutput(input);
    const callsAfter = codeToHtmlSpy.mock.calls.length;

    expect(callsAfter).toBe(callsBefore);
    expect(result).toBe("not { valid &lt;json&gt; &amp; stuff");
  });

  it("parses, re-stringifies, and highlights valid JSON strings", () => {
    // Use a unique marker so the string cache doesn't pre-empt this case
    // even when tests run in unpredictable order.
    const input = '{"valid-json-case":1,"marker":"vjc-unique"}';

    const callsBefore = codeToHtmlSpy.mock.calls.length;
    const result = formatRawOutput(input);
    const callsAfter = codeToHtmlSpy.mock.calls.length;

    expect(callsAfter - callsBefore).toBe(1);
    // The highlighter was called with the re-stringified (indented) form.
    const [calledWith] = codeToHtmlSpy.mock.calls[callsAfter - 1] as [string, unknown];
    expect(calledWith).toBe(JSON.stringify(JSON.parse(input), null, 2));
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
