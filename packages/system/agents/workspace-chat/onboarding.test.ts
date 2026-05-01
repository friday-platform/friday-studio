import { describe, expect, it } from "vitest";
import { buildOnboardingClause, buildUserProfileClause } from "./onboarding.ts";
import type { UserProfileState } from "./user-profile.ts";

describe("buildOnboardingClause", () => {
  it("returns onboarding clause when status is unknown", () => {
    const state: UserProfileState = { status: "unknown" };
    const clause = buildOnboardingClause(state);
    expect(clause).toBeDefined();
    expect(clause).toContain("<onboarding>");
    expect(clause).toContain("</onboarding>");
    expect(clause).toContain("memory_save");
    expect(clause).toContain("user-name");
    expect(clause).toContain("name-declined");
  });

  it("returns undefined when status is known", () => {
    const state: UserProfileState = { status: "known", name: "Ken" };
    expect(buildOnboardingClause(state)).toBeUndefined();
  });

  it("returns undefined when status is declined", () => {
    const state: UserProfileState = { status: "declined" };
    expect(buildOnboardingClause(state)).toBeUndefined();
  });
});

describe("buildUserProfileClause", () => {
  it("returns user_profile section with name when known", () => {
    const state: UserProfileState = { status: "known", name: "Ken" };
    const clause = buildUserProfileClause(state);
    expect(clause).toBeDefined();
    expect(clause).toContain("<user_profile>");
    expect(clause).toContain("Ken");
  });

  it("returns undefined when status is unknown", () => {
    const state: UserProfileState = { status: "unknown" };
    expect(buildUserProfileClause(state)).toBeUndefined();
  });

  it("returns undefined when status is declined", () => {
    const state: UserProfileState = { status: "declined" };
    expect(buildUserProfileClause(state)).toBeUndefined();
  });
});
