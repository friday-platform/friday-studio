import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFeatureFlags, parseCookieOverrides } from "./feature-flags.ts";

// __FEATURE_FLAGS__ is a build-time global injected by Vite
vi.stubGlobal("__FEATURE_FLAGS__", []);

beforeEach(() => {
  vi.stubGlobal("__FEATURE_FLAGS__", []);
});

describe("parseCookieOverrides", () => {
  it("returns empty object for empty string", () => {
    expect(parseCookieOverrides("")).toEqual({});
  });

  it("parses a single true override", () => {
    expect(parseCookieOverrides("ff:ENABLE_SKILL_ASSETS=true")).toEqual({
      ENABLE_SKILL_ASSETS: true,
    });
  });

  it("parses a single false override", () => {
    expect(parseCookieOverrides("ff:ENABLE_SKILL_ASSETS=false")).toEqual({
      ENABLE_SKILL_ASSETS: false,
    });
  });

  it("parses multiple overrides from a cookie header", () => {
    const header = "ff:ENABLE_SKILL_ASSETS=true; ff:ENABLE_LIBRARY_FILTERS=false; session=abc123";
    expect(parseCookieOverrides(header)).toEqual({
      ENABLE_SKILL_ASSETS: true,
      ENABLE_LIBRARY_FILTERS: false,
    });
  });

  it("ignores unknown flag names", () => {
    expect(parseCookieOverrides("ff:ENABLE_NONEXISTENT=true")).toEqual({});
  });

  it("ignores non-ff cookies", () => {
    expect(parseCookieOverrides("session=abc; theme=dark")).toEqual({});
  });

  it("treats any value other than 'true' as false", () => {
    expect(parseCookieOverrides("ff:ENABLE_SKILL_ASSETS=yes")).toEqual({
      ENABLE_SKILL_ASSETS: false,
    });
  });

  it("handles whitespace around semicolons", () => {
    const header = "  ff:ENABLE_SKILL_ASSETS=true ;  ff:ENABLE_SKILL_REFERENCES=true  ";
    expect(parseCookieOverrides(header)).toEqual({
      ENABLE_SKILL_ASSETS: true,
      ENABLE_SKILL_REFERENCES: true,
    });
  });
});

describe("buildFeatureFlags", () => {
  it("returns all defaults when no overrides", () => {
    const flags = buildFeatureFlags();
    expect(flags.ENABLE_SKILL_ASSETS).toBe(false);
    expect(flags.ENABLE_LIBRARY_FILTERS).toBe(false);
    expect(flags.ENABLE_WORKSPACE_NAV_ACTIVITY).toBe(false);
  });

  it("applies env overrides from __FEATURE_FLAGS__", () => {
    vi.stubGlobal("__FEATURE_FLAGS__", ["ENABLE_SKILL_ASSETS", "ENABLE_LIBRARY_FILTERS"]);
    const flags = buildFeatureFlags();
    expect(flags.ENABLE_SKILL_ASSETS).toBe(true);
    expect(flags.ENABLE_LIBRARY_FILTERS).toBe(true);
    expect(flags.ENABLE_SKILL_REFERENCES).toBe(false);
  });

  it("ignores unknown env flag names", () => {
    vi.stubGlobal("__FEATURE_FLAGS__", ["ENABLE_NONEXISTENT"]);
    const flags = buildFeatureFlags();
    expect(flags).not.toHaveProperty("ENABLE_NONEXISTENT");
  });

  it("applies cookie overrides", () => {
    const flags = buildFeatureFlags({ ENABLE_SKILL_ASSETS: true });
    expect(flags.ENABLE_SKILL_ASSETS).toBe(true);
  });

  it("cookie overrides take precedence over env overrides", () => {
    vi.stubGlobal("__FEATURE_FLAGS__", ["ENABLE_SKILL_ASSETS"]);
    const flags = buildFeatureFlags({ ENABLE_SKILL_ASSETS: false });
    expect(flags.ENABLE_SKILL_ASSETS).toBe(false);
  });

  it("returns a frozen object", () => {
    const flags = buildFeatureFlags();
    expect(Object.isFrozen(flags)).toBe(true);
  });
});
