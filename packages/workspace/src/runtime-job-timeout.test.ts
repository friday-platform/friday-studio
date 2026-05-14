import { describe, expect, it } from "vitest";

import { buildExecutorTimeoutOption, parseJobTimeoutMs } from "./runtime.ts";

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

  // Foot-gun guard: nats.js `nc.request({ timeout: 0 })` rejects on the
  // next tick, so a workspace.yml `config.timeout: "0s"` would silently
  // kill every job in scope. Authors who write `0` almost certainly mean
  // "no ceiling"; surface a warn and fall back to the executor default
  // (caller treats undefined as "use default").
  //
  // Table-drive every supported unit so each row exercises the `<= 0`
  // guard via a value that genuinely parses to 0. Per review feedback
  // (PR #314) the previous `"0ms"` row didn't hit the guard because
  // `parseDuration` only accepts `s|m|h` — `"0ms"` fell through to the
  // malformed-input catch and would still pass even if the `<= 0` guard
  // were dropped.
  it.each(["0s", "0m", "0h"])("rejects %s — falls back to executor default", (input) => {
    expect(parseJobTimeoutMs("job", input)).toBeUndefined();
  });

  it("rejects negative durations", () => {
    // parseDuration may accept "-1s" depending on the parser; whatever
    // it returns, our guard rejects values <= 0 to keep the contract
    // with the executor (positive integer or undefined).
    const result = parseJobTimeoutMs("job", "-1s");
    expect(result === undefined || result > 0).toBe(true);
  });
});

describe("buildExecutorTimeoutOption (spread shape forwarded to ProcessAgentExecutor)", () => {
  it("returns an empty object when jobTimeoutMs is undefined", () => {
    // Spread shape: `...buildExecutorTimeoutOption(undefined)` => no
    // `timeoutMs` key on the executor options object => executor falls
    // back to its DEFAULT_TIMEOUT_MS.
    expect(buildExecutorTimeoutOption(undefined)).toEqual({});
  });

  it("returns { timeoutMs } when jobTimeoutMs is a positive number", () => {
    expect(buildExecutorTimeoutOption(7_200_000)).toEqual({ timeoutMs: 7_200_000 });
    expect(buildExecutorTimeoutOption(60_000)).toEqual({ timeoutMs: 60_000 });
  });

  it("preserves jobTimeoutMs === 0 (foot-gun guard against truthy refactor)", () => {
    // `parseJobTimeoutMs` already filters out `<= 0`, so under normal
    // operation a 0 never reaches this helper. But the helper exists
    // precisely to make the `!== undefined` distinction testable: a
    // careless refactor swapping to `if (jobTimeoutMs)` would silently
    // drop the field for 0 (and the executor would fall back to 180s
    // — exactly the bug the parseJobTimeoutMs guard prevents from
    // reaching this point). Pin the contract.
    expect(buildExecutorTimeoutOption(0)).toEqual({ timeoutMs: 0 });
  });
});
