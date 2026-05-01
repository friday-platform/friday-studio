import { describe, expect, it } from "vitest";
import { assertGlobalWriteAllowed, isGlobalWriteAttempt } from "../global-scope-guard.ts";
import { MountScopeError } from "../mount-errors.ts";

describe("assertGlobalWriteAllowed", () => {
  it("allows kernel workspace to write to _global", () => {
    expect(() => {
      assertGlobalWriteAllowed("thick_endive", "thick_endive");
    }).not.toThrow();
  });

  it("throws MountScopeError for non-kernel callers", () => {
    expect(() => {
      assertGlobalWriteAllowed("braised_biscuit", "thick_endive");
    }).toThrow(MountScopeError);
  });

  it("throws MountScopeError when kernelWorkspaceId is undefined", () => {
    expect(() => {
      assertGlobalWriteAllowed("braised_biscuit", undefined);
    }).toThrow(MountScopeError);
  });

  it("thrown error carries MOUNT_SCOPE_ERROR code", () => {
    try {
      assertGlobalWriteAllowed("braised_biscuit", "thick_endive");
    } catch (e) {
      expect(e).toBeInstanceOf(MountScopeError);
      expect((e as MountScopeError).code).toBe("MOUNT_SCOPE_ERROR");
      return;
    }
    expect.fail("expected MountScopeError to be thrown");
  });
});

describe("isGlobalWriteAttempt", () => {
  it("returns true for _global + rw", () => {
    expect(isGlobalWriteAttempt("_global", "rw")).toBe(true);
  });

  it("returns false for _global + ro", () => {
    expect(isGlobalWriteAttempt("_global", "ro")).toBe(false);
  });

  it("returns false for non-global + rw", () => {
    expect(isGlobalWriteAttempt("braised_biscuit", "rw")).toBe(false);
  });

  it("returns false for non-global + ro", () => {
    expect(isGlobalWriteAttempt("braised_biscuit", "ro")).toBe(false);
  });
});
