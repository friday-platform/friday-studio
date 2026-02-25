import { createLoadSkillTool, SkillStorage } from "@atlas/skills";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skills } from "../skills/index.ts";

// =============================================================================
// Helpers
// =============================================================================

const TOOL_CALL_OPTS = { toolCallId: "test", messages: [] as never[], abortSignal: undefined };

// =============================================================================
// Mocks
// =============================================================================

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// Tests
// =============================================================================

describe("createLoadSkillTool with hardcoded skills", () => {
  it("returns hardcoded skill when ID matches", async () => {
    const getSpy = vi.spyOn(SkillStorage, "get");

    const { tool } = createLoadSkillTool({ hardcodedSkills: skills });
    // biome-ignore lint/style/noNonNullAssertion: test code - tool.execute is always defined
    const result = await tool.execute!(
      { name: "workspace-creation", reason: "testing" },
      TOOL_CALL_OPTS,
    );

    expect(getSpy).not.toHaveBeenCalled();
    expect("name" in result).toBe(true);
    if ("name" in result) {
      expect(result.name).toBe("workspace-creation");
      expect(typeof result.instructions).toBe("string");
      // biome-ignore lint/style/noNonNullAssertion: test code - instructions is defined when name is present
      expect(result.instructions!.includes("# Workspace Creation")).toBe(true);
    }
  });

  it("hardcoded takes precedence over global catalog", async () => {
    // Even if storage has a skill, hardcoded should win
    const getSpy = vi.spyOn(SkillStorage, "get");

    const { tool } = createLoadSkillTool({ hardcodedSkills: skills });
    // biome-ignore lint/style/noNonNullAssertion: test code - tool.execute is always defined
    const result = await tool.execute!({ name: "workspace-creation" }, TOOL_CALL_OPTS);

    expect(getSpy).not.toHaveBeenCalled();
    expect("name" in result).toBe(true);
    if ("name" in result) {
      expect(result.name).toBe("workspace-creation");
    }
  });

  it("returns error when skill not found in either source", async () => {
    const { tool } = createLoadSkillTool({ hardcodedSkills: skills });
    // biome-ignore lint/style/noNonNullAssertion: test code - tool.execute is always defined
    const result = await tool.execute!({ name: "nonexistent-skill" }, TOOL_CALL_OPTS);

    expect("error" in result).toBe(true);
    if ("error" in result) {
      // biome-ignore lint/style/noNonNullAssertion: test code - error is defined when error in result
      expect(result.error!).toContain("nonexistent-skill");
      // biome-ignore lint/style/noNonNullAssertion: test code - error is defined when error in result
      expect(result.error!).toContain("not found");
    }
  });

  it("includes hardcoded skill IDs in tool description when provided", () => {
    const { tool } = createLoadSkillTool({ hardcodedSkills: skills });
    expect(tool.description).toContain("workspace-creation");
    expect(tool.description).toContain("Workspace skills also available");
  });

  it("has instructive description when no hardcoded skills provided", () => {
    const { tool } = createLoadSkillTool();
    expect(tool.description).toContain("Load skill instructions BEFORE starting a task");
    expect(tool.description).toContain("Check <available_skills>");
  });
});
