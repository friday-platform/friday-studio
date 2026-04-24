import { describe, expect, it } from "vitest";
import { backoffDelay } from "./session-event-stream.ts";

describe("backoffDelay", () => {
  it("returns 1000ms for first attempt", () => {
    expect(backoffDelay(0)).toBe(1000);
  });

  it("returns 2000ms for second attempt", () => {
    expect(backoffDelay(1)).toBe(2000);
  });

  it("returns 4000ms for third attempt", () => {
    expect(backoffDelay(2)).toBe(4000);
  });
});
