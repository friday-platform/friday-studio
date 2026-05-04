import { describe, expect, it } from "vitest";
import { buildOnboardingClause } from "./onboarding.ts";
import type { UserProfileState } from "./user-profile.ts";

describe("buildOnboardingClause", () => {
  it("returns onboarding clause when status is unknown", () => {
    const state: UserProfileState = { status: "unknown" };
    const clause = buildOnboardingClause(state);
    expect(clause).toBeDefined();
    expect(clause).toContain("<onboarding>");
    expect(clause).toContain("</onboarding>");
    expect(clause).toContain("set_user_identity");
    expect(clause).toContain("name");
    expect(clause).toContain("declined");
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
