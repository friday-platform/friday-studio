import { describe, expect, it } from "vitest";
import { truncateUnicode } from "../mod.ts";

describe("truncateUnicode", () => {
  it("truncates plain ASCII to maxLength code points", () => {
    expect(truncateUnicode("hello world", 5)).toBe("hello");
  });

  it("returns string unchanged when shorter than maxLength", () => {
    expect(truncateUnicode("short", 100)).toBe("short");
  });

  it("returns empty string for falsy input", () => {
    expect(truncateUnicode(undefined, 10)).toBe("");
    expect(truncateUnicode("", 10)).toBe("");
  });

  it("truncates by code points, not UTF-16 code units", () => {
    // "📊 data" — 📊 is one code point but two UTF-16 code units
    expect(truncateUnicode("📊 data", 1)).toBe("📊");
    expect(truncateUnicode("📊 data", 3)).toBe("📊 d");
  });

  it("strips null bytes", () => {
    expect(truncateUnicode("hello\u0000world\u0000!", 100)).toBe("helloworld!");
  });

  it("strips null bytes before counting code points", () => {
    // 5 visible chars + 2 null bytes = 7 code units, but after stripping nulls
    // only 5 code points remain — so maxLength 5 should return the full clean string
    expect(truncateUnicode("hel\u0000lo", 5)).toBe("hello");
  });

  it("returns empty string when maxLength is 0", () => {
    expect(truncateUnicode("hello", 0)).toBe("");
  });

  it("returns string unchanged when exactly maxLength code points", () => {
    expect(truncateUnicode("exact", 5)).toBe("exact");
  });

  it("splits at code-point level, not grapheme cluster level (known limitation)", () => {
    // Family emoji: 7 code points (4 people + 3 ZWJ), 1 visible grapheme
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    // Truncating at 1 code point splits the ZWJ sequence — acceptable for DB storage
    expect([...truncateUnicode(family, 1)].length).toBe(1);
    expect(truncateUnicode(family, 7)).toBe(family);
  });

  it("appends ellipsis only when truncation occurs, total <= maxLength", () => {
    // "hello world" is 11 code points, maxLength 8 with "..." →
    // 8 - 3 = 5 content code points + "..." = "hello..." (8 total)
    expect(truncateUnicode("hello world", 8, "...")).toBe("hello...");
    expect([...truncateUnicode("hello world", 8, "...")].length).toBe(8);
    // No truncation needed — returned as-is
    expect(truncateUnicode("short", 100, "...")).toBe("short");
    expect(truncateUnicode("exact", 5, "...")).toBe("exact");
  });

  it("does not append ellipsis to falsy input", () => {
    expect(truncateUnicode(undefined, 10, "...")).toBe("");
    expect(truncateUnicode("", 10, "...")).toBe("");
  });

  it("strips null bytes before deciding whether to append ellipsis", () => {
    // 5 visible chars + null byte = 6 code units, but after stripping
    // only 5 remain — no truncation needed, no ellipsis
    expect(truncateUnicode("hel\u0000lo", 5, "...")).toBe("hello");
    // 6 visible chars + null byte — needs truncation, total capped at 5
    // 5 - 3 = 2 content code points + "..." = "he..." (5 total)
    expect(truncateUnicode("hel\u0000lo!", 5, "...")).toBe("he...");
  });

  it("handles production case: emoji near truncation boundary in long string", () => {
    const summary =
      "---\n\n## 📊 Ad Platform Performance Analysis\n\n" +
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(5);

    const result = truncateUnicode(summary, 200);

    expect([...result].length).toBe(200);
    // No lone surrogates — PostgreSQL JSONB would reject them (SQLSTATE 22P02)
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
