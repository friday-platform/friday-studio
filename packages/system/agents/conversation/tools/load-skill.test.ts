import { createLoadSkillTool, SkillStorage } from "@atlas/skills";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skills } from "../skills/index.ts";

// =============================================================================
// Test Fixtures
// =============================================================================

const TEST_WORKSPACE_ID = "ws-test-123";

const workspaceSkill = {
  id: "skill-001",
  name: "my-workspace-skill",
  description: "A workspace skill",
  instructions: "# Workspace Skill\n\nDo workspace things.",
  workspaceId: TEST_WORKSPACE_ID,
  createdBy: "user-123",
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
};

// =============================================================================
// Mock Helpers
// =============================================================================

let originalGetByName: typeof SkillStorage.getByName;

function mockSkillStorageGetByName(
  result: { ok: true; data: typeof workspaceSkill | null } | { ok: false; error: string },
): void {
  SkillStorage.getByName = () => Promise.resolve(result);
}

// =============================================================================
// Tests
// =============================================================================

describe("createLoadSkillTool with hardcoded skills", () => {
  beforeEach(() => {
    originalGetByName = SkillStorage.getByName;
  });

  afterEach(() => {
    SkillStorage.getByName = originalGetByName;
  });

  it("returns hardcoded skill when ID matches", async () => {
    // Mock should not be called for hardcoded skills
    let getByNameCalled = false;
    SkillStorage.getByName = () => {
      getByNameCalled = true;
      return Promise.resolve({ ok: true, data: null });
    };

    const tool = createLoadSkillTool(TEST_WORKSPACE_ID, { hardcodedSkills: skills });
    // biome-ignore lint/style/noNonNullAssertion: test code - tool.execute is always defined
    const result = await tool.execute!(
      { name: "workspace-creation", reason: "testing" },
      { toolCallId: "test", messages: [], abortSignal: undefined },
    );

    expect(getByNameCalled).toBe(false);
    expect("name" in result).toBe(true);
    if ("name" in result) {
      expect(result.name).toBe("workspace-creation");
      expect(typeof result.instructions).toBe("string");
      // biome-ignore lint/style/noNonNullAssertion: test code - instructions is defined when name is present
      expect(result.instructions!.includes("# Workspace Creation")).toBe(true);
    }
  });

  it("returns workspace skill when not in hardcoded list", async () => {
    mockSkillStorageGetByName({ ok: true, data: workspaceSkill });

    const tool = createLoadSkillTool(TEST_WORKSPACE_ID, { hardcodedSkills: skills });
    // biome-ignore lint/style/noNonNullAssertion: test code - tool.execute is always defined
    const result = await tool.execute!(
      { name: "my-workspace-skill" },
      { toolCallId: "test", messages: [], abortSignal: undefined },
    );

    expect("name" in result).toBe(true);
    if ("name" in result) {
      expect(result.name).toBe("my-workspace-skill");
      expect(result.instructions).toBe("# Workspace Skill\n\nDo workspace things.");
    }
  });

  it("hardcoded takes precedence over workspace skill with same name", async () => {
    // Workspace skill with same ID as hardcoded
    const conflictingWorkspaceSkill = {
      ...workspaceSkill,
      name: "workspace-creation",
      instructions: "# DIFFERENT Instructions from workspace",
    };
    mockSkillStorageGetByName({ ok: true, data: conflictingWorkspaceSkill });

    const tool = createLoadSkillTool(TEST_WORKSPACE_ID, { hardcodedSkills: skills });
    // biome-ignore lint/style/noNonNullAssertion: test code - tool.execute is always defined
    const result = await tool.execute!(
      { name: "workspace-creation" },
      { toolCallId: "test", messages: [], abortSignal: undefined },
    );

    expect("name" in result).toBe(true);
    if ("name" in result) {
      expect(result.name).toBe("workspace-creation");
      // Should return hardcoded instructions, not workspace instructions
      // biome-ignore lint/style/noNonNullAssertion: test code - instructions is defined when name is present
      expect(result.instructions!.includes("# Workspace Creation")).toBe(true);
      // biome-ignore lint/style/noNonNullAssertion: test code - instructions is defined when name is present
      expect(result.instructions!.includes("DIFFERENT")).toBe(false);
    }
  });

  it("returns error when skill not found in either source", async () => {
    mockSkillStorageGetByName({ ok: true, data: null });

    const tool = createLoadSkillTool(TEST_WORKSPACE_ID, { hardcodedSkills: skills });
    // biome-ignore lint/style/noNonNullAssertion: test code - tool.execute is always defined
    const result = await tool.execute!(
      { name: "nonexistent-skill" },
      { toolCallId: "test", messages: [], abortSignal: undefined },
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      // biome-ignore lint/style/noNonNullAssertion: test code - error is defined when error in result
      expect(result.error!.includes("nonexistent-skill")).toBe(true);
      // biome-ignore lint/style/noNonNullAssertion: test code - error is defined when error in result
      expect(result.error!.includes("not found")).toBe(true);
    }
  });

  it("returns error when SkillStorage.getByName fails", async () => {
    mockSkillStorageGetByName({ ok: false, error: "Database connection failed" });

    const tool = createLoadSkillTool(TEST_WORKSPACE_ID, { hardcodedSkills: skills });
    // biome-ignore lint/style/noNonNullAssertion: test code - tool.execute is always defined
    const result = await tool.execute!(
      { name: "some-workspace-skill" },
      { toolCallId: "test", messages: [], abortSignal: undefined },
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("Database connection failed");
    }
  });

  it("includes hardcoded skill IDs in tool description when provided", () => {
    const tool = createLoadSkillTool(TEST_WORKSPACE_ID, { hardcodedSkills: skills });
    expect(tool.description?.includes("workspace-creation")).toBe(true);
    expect(tool.description?.includes("Workspace skills also available")).toBe(true);
  });

  it("has instructive description when no hardcoded skills provided", () => {
    const tool = createLoadSkillTool(TEST_WORKSPACE_ID);
    expect(tool.description).toContain("Load skill instructions BEFORE starting a task");
    expect(tool.description).toContain("Check <available_skills>");
  });

  it("works without hardcoded skills (basic mode)", async () => {
    mockSkillStorageGetByName({ ok: true, data: workspaceSkill });

    // No hardcoded skills - basic workspace-only mode
    const tool = createLoadSkillTool(TEST_WORKSPACE_ID);
    // biome-ignore lint/style/noNonNullAssertion: test code - tool.execute is always defined
    const result = await tool.execute!(
      { name: "my-workspace-skill" },
      { toolCallId: "test", messages: [], abortSignal: undefined },
    );

    expect("name" in result).toBe(true);
    if ("name" in result) {
      expect(result.name).toBe("my-workspace-skill");
      expect(result.description).toBe("A workspace skill");
      expect(result.instructions).toBe("# Workspace Skill\n\nDo workspace things.");
    }
  });
});
