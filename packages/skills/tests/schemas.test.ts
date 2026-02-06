import { describe, expect, it } from "vitest";
import { SkillNameSchema } from "../src/schemas.ts";

describe("SkillNameSchema", () => {
  it("accepts valid names", () => {
    expect(SkillNameSchema.safeParse("my-skill").success).toBe(true);
    expect(SkillNameSchema.safeParse("skill123").success).toBe(true);
    expect(SkillNameSchema.safeParse("a").success).toBe(true);
    expect(SkillNameSchema.safeParse("test-skill-name").success).toBe(true);
  });

  it("rejects uppercase", () => {
    expect(SkillNameSchema.safeParse("MySkill").success).toBe(false);
  });

  it("rejects leading/trailing hyphens", () => {
    expect(SkillNameSchema.safeParse("-skill").success).toBe(false);
    expect(SkillNameSchema.safeParse("skill-").success).toBe(false);
  });

  it("rejects consecutive hyphens", () => {
    expect(SkillNameSchema.safeParse("my--skill").success).toBe(false);
  });

  it("rejects empty", () => {
    expect(SkillNameSchema.safeParse("").success).toBe(false);
  });

  it("rejects >64 chars", () => {
    expect(SkillNameSchema.safeParse("a".repeat(65)).success).toBe(false);
  });
});
