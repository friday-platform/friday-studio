import { describe, expect, it } from "vitest";
import {
  isDirty,
  resolveDescriptionManual,
  shouldInterceptNavigation,
  type SkillData,
  type SkillDraft,
} from "./skill-page-helpers.ts";

// ---------------------------------------------------------------------------
// isDirty
// ---------------------------------------------------------------------------
describe("isDirty", () => {
  const baseSkill: SkillData = {
    instructions: "do stuff",
    name: "my-skill",
    description: "a skill",
    descriptionManual: false,
  };

  const cleanDraft: SkillDraft = {
    instructions: "do stuff",
    slug: "my-skill",
    description: "a skill",
    descriptionManual: false,
  };

  it("returns false when draft matches skill", () => {
    expect(isDirty(cleanDraft, baseSkill)).toBe(false);
  });

  it("returns false when skill is undefined", () => {
    expect(isDirty(cleanDraft, undefined)).toBe(false);
  });

  it("detects changed instructions", () => {
    expect(isDirty({ ...cleanDraft, instructions: "new" }, baseSkill)).toBe(true);
  });

  it("detects changed slug", () => {
    expect(isDirty({ ...cleanDraft, slug: "other-name" }, baseSkill)).toBe(true);
  });

  it("detects changed description", () => {
    expect(isDirty({ ...cleanDraft, description: "updated" }, baseSkill)).toBe(true);
  });

  it("detects changed descriptionManual flag", () => {
    expect(isDirty({ ...cleanDraft, descriptionManual: true }, baseSkill)).toBe(true);
  });

  it("treats null skill name as empty string for comparison", () => {
    const skillWithNullName: SkillData = { ...baseSkill, name: null };
    const draftWithEmptySlug: SkillDraft = { ...cleanDraft, slug: "" };
    expect(isDirty(draftWithEmptySlug, skillWithNullName)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldInterceptNavigation
// ---------------------------------------------------------------------------
describe("shouldInterceptNavigation", () => {
  it("returns false for goto navigations even when dirty (loop guard)", () => {
    expect(shouldInterceptNavigation("goto", true)).toBe(false);
  });

  it("returns false for goto navigations when clean", () => {
    expect(shouldInterceptNavigation("goto", false)).toBe(false);
  });

  it("returns true for non-goto navigations when dirty", () => {
    expect(shouldInterceptNavigation("popstate", true)).toBe(true);
    expect(shouldInterceptNavigation("link", true)).toBe(true);
  });

  it("returns false for non-goto navigations when clean", () => {
    expect(shouldInterceptNavigation("popstate", false)).toBe(false);
    expect(shouldInterceptNavigation("link", false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveDescriptionManual
// ---------------------------------------------------------------------------
describe("resolveDescriptionManual", () => {
  it("sets manual to true when user types content and was auto", () => {
    expect(resolveDescriptionManual(false, "hello")).toBe(true);
  });

  it("keeps manual true when user types content and was already manual", () => {
    expect(resolveDescriptionManual(true, "hello")).toBe(true);
  });

  it("resets to auto when description is cleared", () => {
    expect(resolveDescriptionManual(true, "")).toBe(false);
  });

  it("resets to auto when description is only whitespace", () => {
    expect(resolveDescriptionManual(true, "   ")).toBe(false);
  });

  it("stays auto when description is empty and was auto", () => {
    expect(resolveDescriptionManual(false, "")).toBe(false);
  });
});
