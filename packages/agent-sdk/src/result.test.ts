/**
 * Tests for AgentPayload helpers
 */

import { describe, expect, it } from "vitest";
import { err, ok } from "./result.ts";

describe("ok()", () => {
  it("returns success payload with data", () => {
    const result = ok({ response: "hello" });
    expect(result).toEqual({ ok: true, data: { response: "hello" } });
  });

  it("returns success payload with extras", () => {
    const result = ok(
      { response: "hello" },
      { reasoning: "because", artifactRefs: [{ id: "art_123", type: "summary", summary: "test" }] },
    );
    expect(result).toEqual({
      ok: true,
      data: { response: "hello" },
      reasoning: "because",
      artifactRefs: [{ id: "art_123", type: "summary", summary: "test" }],
    });
  });

  it("infers correct type", () => {
    const result = ok({ count: 42 });
    // Type inference check - this should compile
    const _data: { count: number } = result.data;
    expect(_data.count).toBe(42);
  });
});

describe("err()", () => {
  it("returns error payload with reason", () => {
    const result = err("something went wrong");
    expect(result).toEqual({ ok: false, error: { reason: "something went wrong" } });
  });
});
