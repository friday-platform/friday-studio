import { describe, expect, it } from "vitest";
import type { ResolvedSkill } from "../skill-adapter.ts";
import type { AgentSkill } from "../types.ts";

describe("SkillAdapter type contracts", () => {
  it("ResolvedSkill extends AgentSkill", () => {
    const check: ResolvedSkill extends AgentSkill ? true : false = true;
    expect(check).toBe(true);
  });

  it("ResolvedSkill carries version: string", () => {
    const skill: ResolvedSkill = {
      name: "test-skill",
      description: "A test skill",
      instructions: "Do the thing",
      version: "1.0.0",
    };
    expect(skill.version).toBe("1.0.0");
    expect(typeof skill.version).toBe("string");
  });

  it("ResolvedSkill inherits AgentSkill fields", () => {
    const skill: ResolvedSkill = {
      name: "another-skill",
      description: "Another skill",
      instructions: "Instructions here",
      version: "2.0.0",
    };
    const asBase: AgentSkill = skill;
    expect(asBase.name).toBe("another-skill");
    expect(asBase.description).toBe("Another skill");
  });
});
