import { Buffer } from "node:buffer";
import type { GlobalSkillRefConfig, InlineSkillConfig } from "@atlas/config";
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

const inlineSkills: InlineSkillConfig[] = [
  {
    name: "my-lint",
    inline: true,
    description: "Custom lint rules",
    instructions: "# Lint\nRun the linter.",
  },
];

const skillEntries: GlobalSkillRefConfig[] = [
  { name: "@atlas/deploy", version: 3 },
  { name: "@atlas/testing" },
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

describe("createLoadSkillTool — three-tier resolution", () => {
  // -------------------------------------------------------------------------
  // Tier 1: Hardcoded
  // -------------------------------------------------------------------------

  it("resolves hardcoded skill by name (tier 1)", async () => {
    const getSpy = vi.spyOn(SkillStorage, "get");

    const tool = createLoadSkillTool({ hardcodedSkills, inlineSkills, skillEntries });
    const result = await exec(tool, "commit");

    expect(getSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ name: "commit", instructions: "# Commit\nRun git commit." });
  });

  // -------------------------------------------------------------------------
  // Tier 2: Inline
  // -------------------------------------------------------------------------

  it("resolves inline skill by name (tier 2)", async () => {
    const getSpy = vi.spyOn(SkillStorage, "get");

    const tool = createLoadSkillTool({ hardcodedSkills, inlineSkills, skillEntries });
    const result = await exec(tool, "my-lint");

    expect(getSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      name: "my-lint",
      description: "Custom lint rules",
      instructions: "# Lint\nRun the linter.",
    });
  });

  it("hardcoded takes precedence over inline with same name", async () => {
    const conflictInline: InlineSkillConfig[] = [
      {
        name: "commit",
        inline: true,
        description: "Inline commit",
        instructions: "# Inline Commit\nDifferent.",
      },
    ];

    const tool = createLoadSkillTool({
      hardcodedSkills,
      inlineSkills: conflictInline,
      skillEntries: [],
    });
    const result = await exec(tool, "commit");

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
        namespace: "atlas",
        name: "with-files",
        version: 1,
        description: "Skill with files",
        frontmatter: {},
        instructions: "Read $SKILL_DIR/config.json and follow instructions.",
        archive: fakeArchive,
        createdBy: "user-1",
        createdAt: new Date(),
      },
    });

    const tool = createLoadSkillTool({
      hardcodedSkills: [],
      inlineSkills: [],
      skillEntries: [{ name: "@atlas/with-files" }],
    });
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
        namespace: "atlas",
        name: "with-files",
        version: 1,
        description: "Skill with files",
        frontmatter: {},
        instructions: "Read $SKILL_DIR/template.md",
        archive: fakeArchive,
        createdBy: "user-1",
        createdAt: new Date(),
      },
    });

    const result = createLoadSkillTool({
      hardcodedSkills: [],
      inlineSkills: [],
      skillEntries: [{ name: "@atlas/with-files" }],
    });

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
        namespace: "atlas",
        name: "with-files",
        version: 1,
        description: "Skill with files",
        frontmatter: {},
        instructions: "instructions",
        archive: fakeArchive,
        createdBy: "user-1",
        createdAt: new Date(),
      },
    });

    const result = createLoadSkillTool({
      hardcodedSkills: [],
      inlineSkills: [],
      skillEntries: [{ name: "@atlas/with-files" }],
    });

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

  it("returns error for missing global skill with version", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: null });

    const tool = createLoadSkillTool({
      hardcodedSkills: [],
      inlineSkills: [],
      skillEntries: [{ name: "@atlas/deploy", version: 3 }],
    });
    const result = await exec(tool, "@atlas/deploy");

    expect(result).toHaveProperty("error");
    const error = (result as { error: string }).error;
    expect(error).toContain("@atlas/deploy");
    expect(error).toContain("version 3");
    expect(error).toContain("not found");
  });

  it("returns error for missing global skill without version", async () => {
    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: null });

    const tool = createLoadSkillTool({ hardcodedSkills: [], inlineSkills: [], skillEntries: [] });
    const result = await exec(tool, "@atlas/nonexistent");

    expect(result).toHaveProperty("error");
    const error = (result as { error: string }).error;
    expect(error).toContain("@atlas/nonexistent");
    expect(error).toContain("not found");
  });

  it("returns error for unknown non-ref skill name", async () => {
    const tool = createLoadSkillTool({ hardcodedSkills, inlineSkills, skillEntries: [] });
    const result = await exec(tool, "nonexistent");

    expect(result).toHaveProperty("error");
    const error = (result as { error: string }).error;
    expect(error).toContain("nonexistent");
    expect(error).toContain("not found");
  });
});
