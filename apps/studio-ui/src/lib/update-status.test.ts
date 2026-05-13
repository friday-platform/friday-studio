import { describe, expect, it } from "vitest";
import { isDismissed } from "./update-status.svelte.ts";

describe("isDismissed", () => {
  const now = 1_700_000_000_000;
  const inFuture = now + 60_000;
  const inPast = now - 60_000;

  it("returns false when no dismissal exists", () => {
    expect(isDismissed(null, "0.0.38", now)).toBe(false);
  });

  it("returns false when latest version is unknown", () => {
    expect(isDismissed({ version: "0.0.37", until: inFuture }, null, now)).toBe(false);
  });

  it("returns false when dismissal version is older than current latest — newer drop invalidates", () => {
    expect(isDismissed({ version: "0.0.37", until: inFuture }, "0.0.38", now)).toBe(false);
  });

  it("returns false when the 24h window has elapsed", () => {
    expect(isDismissed({ version: "0.0.38", until: inPast }, "0.0.38", now)).toBe(false);
  });

  it("returns true when version matches and window is open", () => {
    expect(isDismissed({ version: "0.0.38", until: inFuture }, "0.0.38", now)).toBe(true);
  });
});
