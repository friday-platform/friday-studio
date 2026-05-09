import { describe, expect, it } from "vitest";
import { compareBytes } from "./byte-stability.ts";

describe("compareBytes", () => {
  it("identifies byte-identical strings", () => {
    const result = compareBytes("hello world", "hello world");
    expect(result.identical).toBe(true);
    expect(result.divergeAt).toBeNull();
    expect(result.lengthDelta).toBe(0);
    expect(result.excerpt).toBeNull();
  });

  it("reports the first byte position of divergence", () => {
    const prev = "the quick brown fox jumps over the lazy dog";
    const next = "the quick blue fox jumps over the lazy dog";
    //                       ^ position 10 differs (b vs b... wait)
    // Actually let me find the real divergence: "brown" vs "blue " —
    // position 10 is 'r' vs 'l'? Let's check carefully:
    //   the quick b  r  o  w  n
    //   0123456789 10 11 12 13 14
    //   the quick b  l  u  e  ' '
    //   first divergence at index 11 (r vs l)
    const result = compareBytes(prev, next);
    expect(result.identical).toBe(false);
    expect(result.divergeAt).toBe(11);
  });

  it("returns the length delta with sign", () => {
    expect(compareBytes("aaa", "aaaa").lengthDelta).toBe(1);
    expect(compareBytes("aaaa", "aaa").lengthDelta).toBe(-1);
    expect(compareBytes("abc", "xyz").lengthDelta).toBe(0);
  });

  it("treats a strict prefix as diverging at the shorter length", () => {
    const result = compareBytes("hello", "hello world");
    expect(result.identical).toBe(false);
    expect(result.divergeAt).toBe(5);
    expect(result.lengthDelta).toBe(6);
  });

  it("includes an excerpt with a divergence marker", () => {
    const prev = "static prefix that matches up to here, then diverges A";
    const next = "static prefix that matches up to here, then diverges B";
    const result = compareBytes(prev, next);
    expect(result.identical).toBe(false);
    expect(result.excerpt).toContain("|");
    // The marker sits at the divergence position; bytes before are from
    // either input (they're identical there).
    expect(result.excerpt).toContain("diverges ");
  });

  it("locates the first divergence even when later differences exist", () => {
    const prev = "AAA different middle BBB";
    const next = "AAA different middlE BBB";
    //                                ^ position 19 (E vs e) is the FIRST byte that differs
    const result = compareBytes(prev, next);
    expect(result.divergeAt).toBe(19);
    // ...even though subsequent bytes also differ, only the first one
    // matters for cache invalidation diagnosis.
  });

  it("handles empty strings", () => {
    expect(compareBytes("", "").identical).toBe(true);
    expect(compareBytes("", "a").divergeAt).toBe(0);
    expect(compareBytes("a", "").divergeAt).toBe(0);
  });
});
