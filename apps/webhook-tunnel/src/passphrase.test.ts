import { describe, expect, test } from "vitest";
import { generatePassphrase } from "./passphrase.ts";

describe("generatePassphrase", () => {
  test("generates 4 words by default", () => {
    const phrase = generatePassphrase();
    const words = phrase.split("-");
    expect(words).toHaveLength(4);
    for (const word of words) {
      expect(word.length).toBeGreaterThan(0);
      expect(word).toMatch(/^[a-z]+$/);
    }
  });

  test("respects custom word count", () => {
    expect(generatePassphrase(2).split("-")).toHaveLength(2);
    expect(generatePassphrase(6).split("-")).toHaveLength(6);
  });

  test("respects custom separator", () => {
    const phrase = generatePassphrase(3, ".");
    expect(phrase.split(".")).toHaveLength(3);
    expect(phrase).not.toContain("-");
  });

  test("generates different phrases each call", () => {
    const phrases = new Set<string>();
    for (let i = 0; i < 20; i++) {
      phrases.add(generatePassphrase());
    }
    // With 256^4 = ~4B combinations, 20 calls should all be unique
    expect(phrases.size).toBe(20);
  });
});
