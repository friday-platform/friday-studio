import type { Logger } from "@atlas/logger";
import { SkillStorage } from "@atlas/skills";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAssignWorkspaceSkillTool, createUnassignWorkspaceSkillTool } from "./skill-tools.ts";

// =============================================================================
// Helpers
// =============================================================================

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } satisfies Record<keyof Logger, unknown>;
}

const TOOL_CALL_OPTS = { toolCallId: "test-call", messages: [] as never[] };

// =============================================================================
// Fixtures
// =============================================================================

const SKILL_DATA = {
  id: "skill-1",
  skillId: "skill-1",
  namespace: "atlas",
  name: "test-skill",
  version: 1,
  description: "A test skill",
  descriptionManual: false,
  disabled: false,
  frontmatter: {},
  instructions: "Do things.",
  archive: null,
  createdBy: "user-1",
  createdAt: new Date(),
} as const;

// =============================================================================
// Mocks
// =============================================================================

beforeEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// assign_workspace_skill
// =============================================================================

describe("createAssignWorkspaceSkillTool", () => {
  const logger = makeLogger();

  it("registers assign_workspace_skill tool", () => {
    const tools = createAssignWorkspaceSkillTool("ws-1", logger);
    expect(tools).toHaveProperty("assign_workspace_skill");
    expect(tools.assign_workspace_skill).toBeDefined();
  });

  it("assigns a valid skill and returns success", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });
    vi.spyOn(SkillStorage, "assignSkill").mockResolvedValue({ ok: true, data: undefined });

    const tools = createAssignWorkspaceSkillTool("ws-1", logger);
    const result = await tools.assign_workspace_skill!.execute!(
      { skillRef: "@atlas/test-skill" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      success: true,
      skill: { ref: "@atlas/test-skill" },
      message: 'Skill "@atlas/test-skill" is now attached to workspace "ws-1".',
    });
    expect(SkillStorage.get).toHaveBeenCalledWith("atlas", "test-skill");
    expect(SkillStorage.assignSkill).toHaveBeenCalledWith("skill-1", "ws-1");
  });

  it("is idempotent — repeated assignment returns success", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });
    vi.spyOn(SkillStorage, "assignSkill").mockResolvedValue({ ok: true, data: undefined });

    const tools = createAssignWorkspaceSkillTool("ws-1", logger);

    const first = await tools.assign_workspace_skill!.execute!(
      { skillRef: "@atlas/test-skill" },
      TOOL_CALL_OPTS,
    );
    const second = await tools.assign_workspace_skill!.execute!(
      { skillRef: "@atlas/test-skill" },
      TOOL_CALL_OPTS,
    );

    expect(first).toEqual(second);
    expect(SkillStorage.assignSkill).toHaveBeenCalledTimes(2);
  });

  it("returns structured error for an invalid skill ref", async () => {
    const tools = createAssignWorkspaceSkillTool("ws-1", logger);
    const result = await tools.assign_workspace_skill!.execute!(
      { skillRef: "not-a-valid-ref" },
      TOOL_CALL_OPTS,
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("Invalid skill reference"),
    });
  });

  it("returns not-found error when skill is missing from catalog", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: null });

    const tools = createAssignWorkspaceSkillTool("ws-1", logger);
    const result = await tools.assign_workspace_skill!.execute!(
      { skillRef: "@atlas/missing" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      success: false,
      error: 'Skill "@atlas/missing" not found in the global catalog.',
    });
  });

  it("returns error when SkillStorage.get fails", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: false, error: "DB timeout" });

    const tools = createAssignWorkspaceSkillTool("ws-1", logger);
    const result = await tools.assign_workspace_skill!.execute!(
      { skillRef: "@atlas/test-skill" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({ success: false, error: "DB timeout" });
  });

  it("returns error when SkillStorage.assignSkill fails", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });
    vi.spyOn(SkillStorage, "assignSkill").mockResolvedValue({
      ok: false,
      error: "constraint violation",
    });

    const tools = createAssignWorkspaceSkillTool("ws-1", logger);
    const result = await tools.assign_workspace_skill!.execute!(
      { skillRef: "@atlas/test-skill" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({ success: false, error: "constraint violation" });
  });

  it("uses workspaceId override when provided", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });
    vi.spyOn(SkillStorage, "assignSkill").mockResolvedValue({ ok: true, data: undefined });

    const tools = createAssignWorkspaceSkillTool("ws-1", logger);
    const result = await tools.assign_workspace_skill!.execute!(
      { skillRef: "@atlas/test-skill", workspaceId: "ws-override" },
      TOOL_CALL_OPTS,
    );

    expect(SkillStorage.assignSkill).toHaveBeenCalledWith("skill-1", "ws-override");
    expect(result).toEqual({
      success: true,
      skill: { ref: "@atlas/test-skill" },
      message: 'Skill "@atlas/test-skill" is now attached to workspace "ws-override".',
    });
  });
});

// =============================================================================
// unassign_workspace_skill
// =============================================================================

describe("createUnassignWorkspaceSkillTool", () => {
  const logger = makeLogger();

  it("registers unassign_workspace_skill tool", () => {
    const tools = createUnassignWorkspaceSkillTool("ws-1", logger);
    expect(tools).toHaveProperty("unassign_workspace_skill");
    expect(tools.unassign_workspace_skill).toBeDefined();
  });

  it("unassigns a valid skill and returns success", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });
    vi.spyOn(SkillStorage, "unassignSkill").mockResolvedValue({ ok: true, data: undefined });

    const tools = createUnassignWorkspaceSkillTool("ws-1", logger);
    const result = await tools.unassign_workspace_skill!.execute!(
      { skillRef: "@atlas/test-skill" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      success: true,
      message: 'Skill "@atlas/test-skill" has been removed from workspace "ws-1".',
    });
    expect(SkillStorage.get).toHaveBeenCalledWith("atlas", "test-skill");
    expect(SkillStorage.unassignSkill).toHaveBeenCalledWith("skill-1", "ws-1");
  });

  it("is idempotent — unassigning a non-assigned skill returns success", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });
    vi.spyOn(SkillStorage, "unassignSkill").mockResolvedValue({ ok: true, data: undefined });

    const tools = createUnassignWorkspaceSkillTool("ws-1", logger);

    const first = await tools.unassign_workspace_skill!.execute!(
      { skillRef: "@atlas/test-skill" },
      TOOL_CALL_OPTS,
    );
    const second = await tools.unassign_workspace_skill!.execute!(
      { skillRef: "@atlas/test-skill" },
      TOOL_CALL_OPTS,
    );

    expect(first).toEqual(second);
    expect(SkillStorage.unassignSkill).toHaveBeenCalledTimes(2);
  });

  it("returns structured error for an invalid skill ref", async () => {
    const tools = createUnassignWorkspaceSkillTool("ws-1", logger);
    const result = await tools.unassign_workspace_skill!.execute!(
      { skillRef: "not-a-valid-ref" },
      TOOL_CALL_OPTS,
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("Invalid skill reference"),
    });
  });

  it("returns not-found error when skill is missing from catalog", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: null });

    const tools = createUnassignWorkspaceSkillTool("ws-1", logger);
    const result = await tools.unassign_workspace_skill!.execute!(
      { skillRef: "@atlas/missing" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      success: false,
      error: 'Skill "@atlas/missing" not found in the global catalog.',
    });
  });

  it("returns error when SkillStorage.get fails", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: false, error: "DB timeout" });

    const tools = createUnassignWorkspaceSkillTool("ws-1", logger);
    const result = await tools.unassign_workspace_skill!.execute!(
      { skillRef: "@atlas/test-skill" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({ success: false, error: "DB timeout" });
  });

  it("returns error when SkillStorage.unassignSkill fails", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });
    vi.spyOn(SkillStorage, "unassignSkill").mockResolvedValue({
      ok: false,
      error: "constraint violation",
    });

    const tools = createUnassignWorkspaceSkillTool("ws-1", logger);
    const result = await tools.unassign_workspace_skill!.execute!(
      { skillRef: "@atlas/test-skill" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({ success: false, error: "constraint violation" });
  });

  it("uses workspaceId override when provided", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });
    vi.spyOn(SkillStorage, "unassignSkill").mockResolvedValue({ ok: true, data: undefined });

    const tools = createUnassignWorkspaceSkillTool("ws-1", logger);
    const result = await tools.unassign_workspace_skill!.execute!(
      { skillRef: "@atlas/test-skill", workspaceId: "ws-override" },
      TOOL_CALL_OPTS,
    );

    expect(SkillStorage.unassignSkill).toHaveBeenCalledWith("skill-1", "ws-override");
    expect(result).toEqual({
      success: true,
      message: 'Skill "@atlas/test-skill" has been removed from workspace "ws-override".',
    });
  });
});
