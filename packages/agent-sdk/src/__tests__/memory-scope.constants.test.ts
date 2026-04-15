import { describe, expect, it } from "vitest";
import { GLOBAL_WORKSPACE_ID, isGlobalScope } from "../memory-scope.ts";

describe("GLOBAL_WORKSPACE_ID", () => {
  it("equals '_global'", () => {
    expect(GLOBAL_WORKSPACE_ID).toBe("_global");
  });
});

describe("isGlobalScope", () => {
  it("returns true for '_global'", () => {
    expect(isGlobalScope("_global")).toBe(true);
  });

  it("returns false for a regular workspace id", () => {
    expect(isGlobalScope("braised_biscuit")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isGlobalScope("")).toBe(false);
  });

  it("returns false for similar-but-wrong strings", () => {
    expect(isGlobalScope("_Global")).toBe(false);
    expect(isGlobalScope("global")).toBe(false);
    expect(isGlobalScope("_global_")).toBe(false);
  });

  it("narrows the type to typeof GLOBAL_WORKSPACE_ID", () => {
    const wsId: string = "_global";
    if (isGlobalScope(wsId)) {
      const narrowed: typeof GLOBAL_WORKSPACE_ID = wsId;
      expect(narrowed).toBe("_global");
    }
  });
});
