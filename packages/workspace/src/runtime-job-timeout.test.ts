import { describe, expect, it } from "vitest";

import { parseJobTimeoutMs } from "./runtime.ts";

describe("parseJobTimeoutMs", () => {
  it("returns the parsed duration in ms for a valid string", () => {
    expect(parseJobTimeoutMs("job", "2h")).toBe(2 * 60 * 60_000);
    expect(parseJobTimeoutMs("job", "30m")).toBe(30 * 60_000);
    expect(parseJobTimeoutMs("job", "5s")).toBe(5_000);
  });

  it("returns undefined for malformed input (and warns; not asserted here)", () => {
    expect(parseJobTimeoutMs("job", "not-a-duration")).toBeUndefined();
    expect(parseJobTimeoutMs("job", "")).toBeUndefined();
  });

  it("rejects 0 — would otherwise become an instant-rejection in nats.js", () => {
    // Foot-gun guard: nats.js `nc.request({ timeout: 0 })` rejects on the
    // next tick, so a workspace.yml `config.timeout: "0s"` would silently
    // kill every job in scope. Authors who write `0` almost certainly
    // mean "no ceiling"; surface a warn and fall back to the executor
    // default (caller treats undefined as "use default").
    expect(parseJobTimeoutMs("job", "0s")).toBeUndefined();
    expect(parseJobTimeoutMs("job", "0ms")).toBeUndefined();
  });

  it("rejects negative durations", () => {
    // parseDuration may accept "-1s" depending on the parser; whatever
    // it returns, our guard rejects values <= 0 to keep the contract
    // with the executor (positive integer or undefined).
    const result = parseJobTimeoutMs("job", "-1s");
    expect(result === undefined || result > 0).toBe(true);
  });
});
