import { describe, expect, it } from "vitest";
import {
  CANONICAL_CONSTRAINTS,
  CANONICAL_WORKSPACE_IDS,
  getCanonicalKind,
  isCanonical,
  isCanonicalEntry,
} from "../canonical.ts";

describe("CANONICAL_WORKSPACE_IDS", () => {
  it("defines personal and system IDs", () => {
    expect(CANONICAL_WORKSPACE_IDS.PERSONAL).toBe("atlas-personal");
    expect(CANONICAL_WORKSPACE_IDS.SYSTEM).toBe("system");
  });
});

describe("CANONICAL_CONSTRAINTS", () => {
  it("personal is non-deletable but renamable and user-editable", () => {
    const c = CANONICAL_CONSTRAINTS.personal;
    expect(c.deletable).toBe(false);
    expect(c.renamable).toBe(true);
    expect(c.userEditable).toBe(true);
  });

  it("system is non-deletable, non-renamable, and non-user-editable", () => {
    const c = CANONICAL_CONSTRAINTS.system;
    expect(c.deletable).toBe(false);
    expect(c.renamable).toBe(false);
    expect(c.userEditable).toBe(false);
  });
});

describe("getCanonicalKind", () => {
  it("returns 'personal' for atlas-personal", () => {
    expect(getCanonicalKind("atlas-personal")).toBe("personal");
  });

  it("returns 'system' for system", () => {
    expect(getCanonicalKind("system")).toBe("system");
  });

  it("returns undefined for non-canonical IDs", () => {
    expect(getCanonicalKind("braised_biscuit")).toBeUndefined();
    expect(getCanonicalKind("")).toBeUndefined();
  });
});

describe("isCanonical", () => {
  it("returns true for canonical IDs", () => {
    expect(isCanonical("atlas-personal")).toBe(true);
    expect(isCanonical("system")).toBe(true);
  });

  it("returns false for non-canonical IDs", () => {
    expect(isCanonical("braised_biscuit")).toBe(false);
    expect(isCanonical("thick_endive")).toBe(false);
  });
});

describe("isCanonicalEntry", () => {
  it("returns true when metadata.canonical is 'personal'", () => {
    expect(isCanonicalEntry({ canonical: "personal" })).toBe(true);
  });

  it("returns true when metadata.canonical is 'system'", () => {
    expect(isCanonicalEntry({ canonical: "system" })).toBe(true);
  });

  it("returns false when metadata is undefined", () => {
    expect(isCanonicalEntry(undefined)).toBe(false);
  });

  it("returns false when canonical is not set", () => {
    expect(isCanonicalEntry({})).toBe(false);
  });
});
