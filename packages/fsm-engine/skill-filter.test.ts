import { describe, expect, it } from "vitest";
import { applySkillAllowlist, unmatchedAllowlistEntries } from "./skill-filter.ts";

const skill = (name: string) => ({ name });

describe("applySkillAllowlist", () => {
  it("returns resolved unchanged when allowlist is undefined (inherit)", () => {
    const resolved = [skill("a"), skill("b"), skill("c")];
    const out = applySkillAllowlist(resolved, undefined);
    expect(out.map((s) => s.name)).toEqual(["a", "b", "c"]);
  });

  it("returns empty when allowlist is an empty array (opt-out)", () => {
    const resolved = [skill("a"), skill("b")];
    const out = applySkillAllowlist(resolved, []);
    expect(out).toEqual([]);
  });

  it("filters resolved by allowlist names (whitelist)", () => {
    const resolved = [skill("a"), skill("b"), skill("c")];
    const out = applySkillAllowlist(resolved, ["a", "c"]);
    expect(out.map((s) => s.name)).toEqual(["a", "c"]);
  });

  it("ignores allowlist entries that don't appear in resolved", () => {
    const resolved = [skill("a"), skill("b")];
    const out = applySkillAllowlist(resolved, ["a", "missing", "b"]);
    expect(out.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("does not mutate the resolved input", () => {
    const resolved = [skill("a"), skill("b")];
    applySkillAllowlist(resolved, ["a"]);
    expect(resolved.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("preserves the resolved order, not the allowlist order", () => {
    const resolved = [skill("a"), skill("b"), skill("c")];
    const out = applySkillAllowlist(resolved, ["c", "a"]);
    expect(out.map((s) => s.name)).toEqual(["a", "c"]);
  });
});

describe("unmatchedAllowlistEntries", () => {
  it("returns [] when allowlist is undefined", () => {
    expect(unmatchedAllowlistEntries([skill("a")], undefined)).toEqual([]);
  });

  it("returns [] when allowlist is empty (opt-out is intentional, not unmatched)", () => {
    expect(unmatchedAllowlistEntries([skill("a")], [])).toEqual([]);
  });

  it("returns names in allowlist that are not present in resolved", () => {
    const resolved = [skill("a"), skill("b")];
    expect(unmatchedAllowlistEntries(resolved, ["a", "missing", "b", "also-missing"])).toEqual([
      "missing",
      "also-missing",
    ]);
  });
});
