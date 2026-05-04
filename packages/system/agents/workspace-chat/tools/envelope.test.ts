import { describe, expect, it } from "vitest";
import { envelope } from "./envelope.ts";

describe("envelope()", () => {
  it("wraps items with provenance + ISO fetched_at", () => {
    const before = Date.now();
    const result = envelope({ items: [1, 2, 3], source: "system-config", origin: "test:fixture" });
    const after = Date.now();

    expect(result.items).toEqual([1, 2, 3]);
    expect(result.provenance.source).toBe("system-config");
    expect(result.provenance.origin).toBe("test:fixture");
    const fetchedAt = Date.parse(result.provenance.fetched_at);
    expect(fetchedAt).toBeGreaterThanOrEqual(before);
    expect(fetchedAt).toBeLessThanOrEqual(after);
    expect(result.cursor).toBeUndefined();
    expect(result.revision).toBeUndefined();
  });

  it("forwards cursor and revision when supplied", () => {
    const result = envelope({
      items: [],
      source: "user-authored",
      origin: "memory:notes",
      cursor: "next-page-token",
      revision: "42",
    });
    expect(result.cursor).toBe("next-page-token");
    expect(result.revision).toBe("42");
    expect(result.provenance.source).toBe("user-authored");
  });
});
