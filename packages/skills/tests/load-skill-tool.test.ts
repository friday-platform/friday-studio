import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HardcodedSkill, LoadSkillToolResult } from "../src/load-skill-tool.ts";
import { createLoadSkillTool } from "../src/load-skill-tool.ts";
import { SkillStorage } from "../src/storage.ts";

// Mock archive module — must be before imports that use it
vi.mock("../src/archive.ts", () => ({
  extractSkillArchive: vi.fn().mockResolvedValue("/tmp/atlas-skill-abc123"),
  injectSkillDir: vi.fn((instructions: string, dir: string) =>
    instructions.replaceAll("$SKILL_DIR", dir),
  ),
}));

// =============================================================================
// Helpers
// =============================================================================

const TOOL_CALL_OPTS = { toolCallId: "test", messages: [] as never[], abortSignal: undefined };

function exec({ tool }: LoadSkillToolResult, name: string, reason?: string) {
  // biome-ignore lint/style/noNonNullAssertion: test helper
  return tool.execute!({ name, reason }, TOOL_CALL_OPTS);
}

// =============================================================================
// Fixtures
// =============================================================================

const hardcodedSkills: readonly HardcodedSkill[] = [
  { id: "commit", description: "Git commit helper", instructions: "# Commit\nRun git commit." },
];

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

describe("createLoadSkillTool — two-tier resolution", () => {
  // -------------------------------------------------------------------------
  // Tier 1: Hardcoded
  // -------------------------------------------------------------------------

  it("resolves hardcoded skill by name (tier 1)", async () => {
    const getSpy = vi.spyOn(SkillStorage, "get");

    const tool = createLoadSkillTool({ hardcodedSkills });
    const result = await exec(tool, "commit");

    expect(getSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ name: "commit", instructions: "# Commit\nRun git commit." });
  });

  // -------------------------------------------------------------------------
  // Archive extraction + $SKILL_DIR
  // -------------------------------------------------------------------------

  it("extracts archive and injects $SKILL_DIR into instructions", async () => {
    const fakeArchive = Buffer.from("fake-archive");

    vi.spyOn(SkillStorage, "get").mockResolvedValue({
      ok: true,
      data: {
        id: "skill-4",
        skillId: "skill-4",
        namespace: "atlas",
        name: "with-files",
        version: 1,
        description: "Skill with files",
        descriptionManual: false,
        disabled: false,
        frontmatter: {},
        instructions: "Read $SKILL_DIR/config.json and follow instructions.",
        archive: fakeArchive,
        createdBy: "user-1",
        createdAt: new Date(),
      },
    });

    const tool = createLoadSkillTool({ hardcodedSkills: [] });
    const result = await exec(tool, "@atlas/with-files");

    expect(result).toMatchObject({
      name: "with-files",
      instructions: "Read /tmp/atlas-skill-abc123/config.json and follow instructions.",
      skillDir: "/tmp/atlas-skill-abc123",
    });
  });

  it("deduplicates archive extraction for same skill loaded twice", async () => {
    const { extractSkillArchive } = await import("../src/archive.ts");
    vi.mocked(extractSkillArchive).mockClear();
    const fakeArchive = Buffer.from("fake-archive");

    vi.spyOn(SkillStorage, "get").mockResolvedValue({
      ok: true,
      data: {
        id: "skill-4",
        skillId: "skill-4",
        namespace: "atlas",
        name: "with-files",
        version: 1,
        description: "Skill with files",
        descriptionManual: false,
        disabled: false,
        frontmatter: {},
        instructions: "Read $SKILL_DIR/template.md",
        archive: fakeArchive,
        createdBy: "user-1",
        createdAt: new Date(),
      },
    });

    const result = createLoadSkillTool({ hardcodedSkills: [] });

    // Load same skill twice
    await exec(result, "@atlas/with-files");
    await exec(result, "@atlas/with-files");

    // extractSkillArchive should only be called once (second load reuses cache)
    expect(extractSkillArchive).toHaveBeenCalledTimes(1);
  });

  it("cleanup clears cache so next load re-extracts", async () => {
    const { extractSkillArchive } = await import("../src/archive.ts");
    vi.mocked(extractSkillArchive).mockClear();
    const fakeArchive = Buffer.from("fake-archive");

    vi.spyOn(SkillStorage, "get").mockResolvedValue({
      ok: true,
      data: {
        id: "skill-4",
        skillId: "skill-4",
        namespace: "atlas",
        name: "with-files",
        version: 1,
        description: "Skill with files",
        descriptionManual: false,
        disabled: false,
        frontmatter: {},
        instructions: "instructions",
        archive: fakeArchive,
        createdBy: "user-1",
        createdAt: new Date(),
      },
    });

    const result = createLoadSkillTool({ hardcodedSkills: [] });

    await exec(result, "@atlas/with-files");
    expect(extractSkillArchive).toHaveBeenCalledTimes(1);

    // Cleanup clears the cache (rm will silently fail on fake path)
    await result.cleanup();

    // Loading again should re-extract since cache was cleared
    await exec(result, "@atlas/with-files");
    expect(extractSkillArchive).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  it("returns error for missing global skill", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: null });

    const tool = createLoadSkillTool({ hardcodedSkills: [] });
    const result = await exec(tool, "@atlas/nonexistent");

    expect(result).toHaveProperty("error");
    const error = (result as { error: string }).error;
    expect(error).toContain("@atlas/nonexistent");
    expect(error).toContain("not found");
  });

  it("returns error for unknown non-ref skill name", async () => {
    const tool = createLoadSkillTool({ hardcodedSkills });
    const result = await exec(tool, "nonexistent");

    expect(result).toHaveProperty("error");
    const error = (result as { error: string }).error;
    expect(error).toContain("nonexistent");
    expect(error).toContain("not found");
  });
});

// =============================================================================
// Workspace scoping (defense in depth)
// =============================================================================

describe("createLoadSkillTool — workspace scoping", () => {
  const SKILL_DATA = {
    id: "skill-1",
    skillId: "skill-1",
    namespace: "atlas",
    name: "internal-tool",
    version: 1,
    description: "Internal tool",
    descriptionManual: false,
    disabled: false,
    frontmatter: {},
    instructions: "Do internal things.",
    archive: null,
    createdBy: "user-1",
    createdAt: new Date(),
  };

  it("loads an unassigned (global) skill in any workspace", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });
    vi.spyOn(SkillStorage, "listAssignments").mockResolvedValue({ ok: true, data: [] });

    const tool = createLoadSkillTool({ hardcodedSkills: [], workspaceId: "ws-1" });
    const result = await exec(tool, "@atlas/internal-tool");

    expect(result).toMatchObject({ name: "internal-tool", instructions: "Do internal things." });
  });

  it("loads a skill assigned to the current workspace", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });
    vi.spyOn(SkillStorage, "listAssignments").mockResolvedValue({
      ok: true,
      data: ["ws-1", "ws-2"],
    });

    const tool = createLoadSkillTool({ hardcodedSkills: [], workspaceId: "ws-1" });
    const result = await exec(tool, "@atlas/internal-tool");

    expect(result).toMatchObject({ name: "internal-tool" });
  });

  it("blocks a skill that is assigned to other workspaces only", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });
    vi.spyOn(SkillStorage, "listAssignments").mockResolvedValue({ ok: true, data: ["ws-other"] });

    const tool = createLoadSkillTool({ hardcodedSkills: [], workspaceId: "ws-1" });
    const result = await exec(tool, "@atlas/internal-tool");

    expect(result).toHaveProperty("error");
    const error = (result as { error: string }).error;
    expect(error).toContain("not available in this workspace");
  });

  it("skips the scoping check entirely when no workspaceId is provided", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });
    const listSpy = vi.spyOn(SkillStorage, "listAssignments");

    const tool = createLoadSkillTool({ hardcodedSkills: [] });
    const result = await exec(tool, "@atlas/internal-tool");

    expect(listSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ name: "internal-tool" });
  });
});

// =============================================================================
// Job-level filter (Phase 7)
// =============================================================================

describe("createLoadSkillTool — jobFilter", () => {
  const SKILL_DATA = {
    id: "skill-1",
    skillId: "skill-1",
    namespace: "tempest",
    name: "allowed",
    version: 1,
    description: "An allowed skill",
    descriptionManual: false,
    disabled: false,
    frontmatter: {},
    instructions: "Allowed.",
    archive: null,
    createdBy: "user-1",
    createdAt: new Date(),
  } as const;

  it("allows catalog skills that are in the jobFilter list", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: SKILL_DATA });
    const tool = createLoadSkillTool({ jobFilter: ["@tempest/allowed"] });
    const result = await exec(tool, "@tempest/allowed");
    expect(result).toMatchObject({ name: "allowed" });
  });

  it("blocks catalog skills missing from the jobFilter list", async () => {
    const getSpy = vi.spyOn(SkillStorage, "get");
    const tool = createLoadSkillTool({ jobFilter: ["@tempest/other"] });
    const result = await exec(tool, "@tempest/blocked");
    expect(result).toMatchObject({
      error: expect.stringContaining("not allowed for this job step"),
    });
    // Blocked before hitting the storage — no DB lookup at all.
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("always allows @friday/* even when not listed in jobFilter", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({
      ok: true,
      data: { ...SKILL_DATA, namespace: "friday", name: "authoring-skills" },
    });
    const tool = createLoadSkillTool({ jobFilter: ["@tempest/other"] });
    const result = await exec(tool, "@friday/authoring-skills");
    expect(result).toMatchObject({ name: "authoring-skills" });
  });

  it("reflects the filter in the tool description", () => {
    const t = createLoadSkillTool({ jobFilter: ["@tempest/a", "@tempest/b"] });
    expect(t.tool.description).toMatch(/filtered for this step/);
    expect(t.tool.description).toContain("@tempest/a");
  });
});
