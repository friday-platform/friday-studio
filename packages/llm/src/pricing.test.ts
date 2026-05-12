import { describe, expect, it } from "vitest";
import { tokensToCost } from "./pricing.ts";

describe("tokensToCost", () => {
  it("returns zeros and pricingResolved=false for unknown models", () => {
    const out = tokensToCost({ inputTokens: 1000, outputTokens: 500 }, "this-model-does-not-exist");
    expect(out.pricingResolved).toBe(false);
    expect(out.total).toBe(0);
  });

  it("computes input + output cost for a known model with no cache fields", () => {
    const out = tokensToCost({ inputTokens: 1000, outputTokens: 500 }, "claude-sonnet-4-6");
    // claude-sonnet-4-6 in pricing.json: input 3e-6, output 15e-6
    expect(out.pricingResolved).toBe(true);
    expect(out.input).toBeCloseTo(1000 * 3e-6, 9);
    expect(out.output).toBeCloseTo(500 * 15e-6, 9);
    expect(out.cacheRead).toBe(0);
    expect(out.cacheWrite).toBe(0);
    expect(out.total).toBeCloseTo(out.input + out.output, 9);
  });

  it("subtracts cacheReadTokens from inputTokens before billing the fresh rate", () => {
    // 1000 input total, 800 served from cache. Only 200 are billed at the
    // fresh rate; the 800 are billed at the read rate.
    const out = tokensToCost(
      { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 800, cacheWriteTokens: 0 },
      "claude-sonnet-4-6",
    );
    // fresh = (1000 - 800) * 3e-6 = 200 * 3e-6 = 6e-4
    // cache read = 800 * 3e-7 = 2.4e-4
    expect(out.input).toBeCloseTo(200 * 3e-6, 9);
    expect(out.cacheRead).toBeCloseTo(800 * 3e-7, 9);
    // Total is fresh-input + cache-read (no output, no cache-write)
    expect(out.total).toBeCloseTo(200 * 3e-6 + 800 * 3e-7, 9);
  });

  it("bills cache writes separately at the creation rate", () => {
    const out = tokensToCost(
      { inputTokens: 5000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 5000 },
      "claude-sonnet-4-6",
    );
    // cache_creation_input_token_cost: 3.75e-6 in pricing.json
    expect(out.cacheWrite).toBeCloseTo(5000 * 3.75e-6, 9);
    // Fresh input is the full 5000 (none cached on a write turn).
    expect(out.input).toBeCloseTo(5000 * 3e-6, 9);
  });

  it("strips a registry prefix when looking up pricing", () => {
    // The chat handler stamps registry-qualified ids like "anthropic:claude-sonnet-4-6".
    // The pricing JSON keys are bare model ids.
    const qualified = tokensToCost(
      { inputTokens: 100, outputTokens: 50 },
      "anthropic:claude-sonnet-4-6",
    );
    const bare = tokensToCost({ inputTokens: 100, outputTokens: 50 }, "claude-sonnet-4-6");
    expect(qualified.pricingResolved).toBe(true);
    expect(qualified.total).toBeCloseTo(bare.total, 12);
  });

  it("strips a slash-prefixed gateway id", () => {
    const qualified = tokensToCost(
      { inputTokens: 100, outputTokens: 50 },
      "anthropic/claude-sonnet-4-6",
    );
    expect(qualified.pricingResolved).toBe(true);
  });

  it("clamps negative fresh-input to zero when cacheRead exceeds inputTokens", () => {
    // Should not be possible in practice — but defensive math means a
    // misreporting provider doesn't produce negative billing.
    const out = tokensToCost(
      { inputTokens: 100, outputTokens: 0, cacheReadTokens: 500 },
      "claude-sonnet-4-6",
    );
    expect(out.input).toBe(0);
    // cacheRead still bills the (mis)reported tokens — surfacing the
    // anomaly rather than silently clamping it too.
    expect(out.cacheRead).toBeGreaterThan(0);
  });

  it("treats absent usage fields as zero", () => {
    const out = tokensToCost({}, "claude-sonnet-4-6");
    expect(out.pricingResolved).toBe(true);
    expect(out.total).toBe(0);
  });
});
