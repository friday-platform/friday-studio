import type { AtlasTools } from "@atlas/agent-sdk";
import type { ResourceEntry } from "@atlas/resources";
import type { SkillSummary } from "@atlas/skills";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import type { ComposedForegroundContext } from "./compose-context.ts";
import {
  composeResources,
  composeSkills,
  composeTools,
  composeWorkspaceSections,
} from "./compose-context.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type WorkspaceDetails = ComposedForegroundContext["details"];

function makeDetails(overrides: Partial<WorkspaceDetails> = {}): WorkspaceDetails {
  return {
    name: "test-workspace",
    agents: [],
    jobs: [],
    signals: [],
    resourceEntries: [],
    orphanedArtifacts: [],
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillSummary> & { skillId: string }): SkillSummary {
  return {
    id: overrides.id ?? `id-${overrides.skillId}`,
    skillId: overrides.skillId,
    namespace: overrides.namespace ?? "test",
    name: overrides.name ?? overrides.skillId,
    description: overrides.description ?? `Description for ${overrides.skillId}`,
    disabled: overrides.disabled ?? false,
    latestVersion: overrides.latestVersion ?? 1,
    createdAt: overrides.createdAt ?? new Date("2026-01-01"),
  };
}

function makeDocumentResource(slug: string, name?: string): ResourceEntry {
  return {
    type: "document" as const,
    slug,
    name: name ?? slug,
    description: `Doc ${slug}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function makeForeground(
  workspaceId: string,
  opts: {
    details?: Partial<WorkspaceDetails>;
    skills?: SkillSummary[];
    resourceEntries?: ResourceEntry[];
  } = {},
): ComposedForegroundContext {
  const details = makeDetails({ name: workspaceId, ...opts.details });
  return {
    workspaceId,
    details,
    skills: opts.skills ?? [],
    resourceEntries: opts.resourceEntries ?? details.resourceEntries,
  };
}

function makeTool(description: string): AtlasTools[string] {
  return tool({ description, inputSchema: jsonSchema({ type: "object", properties: {} }) });
}

// ---------------------------------------------------------------------------
// composeWorkspaceSections
// ---------------------------------------------------------------------------

describe("composeWorkspaceSections", () => {
  it("returns primary section unchanged when foregrounds is empty", () => {
    const primary = '<workspace id="ws-primary" name="Primary">\n</workspace>';
    const result = composeWorkspaceSections(primary, []);
    expect(result).toBe(primary);
  });

  it("includes all workspace XML blocks", () => {
    const primary = '<workspace id="ws-primary" name="Primary">\n</workspace>';
    const fg1 = makeForeground("ws-fg1", { details: { agents: ["agent-a"] } });
    const fg2 = makeForeground("ws-fg2", { details: { description: "Foreground 2" } });

    const result = composeWorkspaceSections(primary, [fg1, fg2]);

    // Primary section present
    expect(result).toContain('id="ws-primary"');
    // Foreground sections present
    expect(result).toContain('id="ws-fg1"');
    expect(result).toContain('id="ws-fg2"');
    // Foreground details rendered
    expect(result).toContain("agent-a");
    expect(result).toContain("Foreground 2");
  });

  it("separates sections with double newlines", () => {
    const primary = '<workspace id="ws-primary" name="Primary">\n</workspace>';
    const fg = makeForeground("ws-fg");
    const result = composeWorkspaceSections(primary, [fg]);

    const sections = result.split("\n\n");
    expect(sections.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// composeSkills
// ---------------------------------------------------------------------------

describe("composeSkills", () => {
  it("returns primary skills unchanged when foregrounds is empty", () => {
    const primary = [makeSkill({ skillId: "skill-a" })];
    const result = composeSkills(primary, []);
    expect(result).toBe(primary);
  });

  it("deduplicates by skillId across workspaces", () => {
    const sharedSkill = makeSkill({ skillId: "shared" });
    const primaryOnly = makeSkill({ skillId: "primary-only" });
    const fgOnly = makeSkill({ skillId: "fg-only" });

    const primary = [sharedSkill, primaryOnly];
    const fg = makeForeground("ws-fg", {
      skills: [makeSkill({ skillId: "shared", description: "duplicate from fg" }), fgOnly],
    });

    const result = composeSkills(primary, [fg]);

    const skillIds = result.map((s) => s.skillId);
    expect(skillIds).toEqual(["shared", "primary-only", "fg-only"]);
    // Primary version of the shared skill wins
    expect(result.find((s) => s.skillId === "shared")?.description).toBe(sharedSkill.description);
  });

  it("merges skills from multiple foregrounds", () => {
    const primary = [makeSkill({ skillId: "a" })];
    const fg1 = makeForeground("ws-1", { skills: [makeSkill({ skillId: "b" })] });
    const fg2 = makeForeground("ws-2", { skills: [makeSkill({ skillId: "c" })] });

    const result = composeSkills(primary, [fg1, fg2]);
    expect(result.map((s) => s.skillId)).toEqual(["a", "b", "c"]);
  });

  it("deduplicates across multiple foregrounds", () => {
    const primary = [makeSkill({ skillId: "a" })];
    const fg1 = makeForeground("ws-1", { skills: [makeSkill({ skillId: "b" })] });
    const fg2 = makeForeground("ws-2", {
      skills: [makeSkill({ skillId: "b" }), makeSkill({ skillId: "c" })],
    });

    const result = composeSkills(primary, [fg1, fg2]);
    expect(result.map((s) => s.skillId)).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// composeTools
// ---------------------------------------------------------------------------

describe("composeTools", () => {
  it("returns primary tools unchanged when foreground tool sets is empty", () => {
    const primary: AtlasTools = { delegate: makeTool("primary delegate") };
    const result = composeTools(primary, []);
    expect(result).toBe(primary);
  });

  it("primary wins on name conflict", () => {
    const primaryTool = makeTool("primary version");
    const fgTool = makeTool("foreground version");

    const primary: AtlasTools = { delegate: primaryTool };
    const foregroundToolSets = [{ workspaceId: "ws-fg", tools: { delegate: fgTool } }];

    const result = composeTools(primary, foregroundToolSets);

    expect(result.delegate).toBe(primaryTool);
    expect(Object.keys(result)).toEqual(["delegate"]);
  });

  it("includes foreground-only tools", () => {
    const primary: AtlasTools = { tool_a: makeTool("primary A") };
    const foregroundToolSets = [{ workspaceId: "ws-fg", tools: { tool_b: makeTool("fg B") } }];

    const result = composeTools(primary, foregroundToolSets);

    expect(Object.keys(result).sort()).toEqual(["tool_a", "tool_b"]);
  });

  it("merges tools from multiple foreground workspaces", () => {
    const primary: AtlasTools = { tool_a: makeTool("A") };
    const foregroundToolSets: Array<{ workspaceId: string; tools: AtlasTools }> = [
      { workspaceId: "ws-1", tools: { tool_b: makeTool("B") } },
      { workspaceId: "ws-2", tools: { tool_c: makeTool("C") } },
    ];

    const result = composeTools(primary, foregroundToolSets);
    expect(Object.keys(result).sort()).toEqual(["tool_a", "tool_b", "tool_c"]);
  });

  it("first foreground wins when multiple foregrounds have the same tool name", () => {
    const fg1Tool = makeTool("fg1 version");
    const fg2Tool = makeTool("fg2 version");

    const primary: AtlasTools = {};
    const foregroundToolSets = [
      { workspaceId: "ws-1", tools: { shared: fg1Tool } },
      { workspaceId: "ws-2", tools: { shared: fg2Tool } },
    ];

    const result = composeTools(primary, foregroundToolSets);

    expect(result.shared).toBe(fg1Tool);
  });
});

// ---------------------------------------------------------------------------
// composeResources
// ---------------------------------------------------------------------------

describe("composeResources", () => {
  it("returns primary resources unchanged when foregrounds is empty", () => {
    const primary = [makeDocumentResource("doc-a")];
    const result = composeResources(primary, []);
    expect(result).toBe(primary);
  });

  it("unions entries from all workspaces", () => {
    const primary = [makeDocumentResource("doc-a")];
    const fg = makeForeground("ws-fg", { resourceEntries: [makeDocumentResource("doc-b")] });

    const result = composeResources(primary, [fg]);
    const slugs = result.map((r) => r.slug);
    expect(slugs).toEqual(["doc-a", "doc-b"]);
  });

  it("deduplicates by slug", () => {
    const primary = [makeDocumentResource("shared-doc")];
    const fg = makeForeground("ws-fg", {
      resourceEntries: [
        makeDocumentResource("shared-doc", "Different Name"),
        makeDocumentResource("unique-doc"),
      ],
    });

    const result = composeResources(primary, [fg]);
    const slugs = result.map((r) => r.slug);
    expect(slugs).toEqual(["shared-doc", "unique-doc"]);
    // Primary version kept for the duplicate
    expect(result.find((r) => r.slug === "shared-doc")?.name).toBe("shared-doc");
  });

  it("merges resources from multiple foregrounds", () => {
    const primary = [makeDocumentResource("a")];
    const fg1 = makeForeground("ws-1", { resourceEntries: [makeDocumentResource("b")] });
    const fg2 = makeForeground("ws-2", { resourceEntries: [makeDocumentResource("c")] });

    const result = composeResources(primary, [fg1, fg2]);
    expect(result.map((r) => r.slug)).toEqual(["a", "b", "c"]);
  });

  it("deduplicates across multiple foregrounds", () => {
    const primary: ResourceEntry[] = [];
    const fg1 = makeForeground("ws-1", { resourceEntries: [makeDocumentResource("x")] });
    const fg2 = makeForeground("ws-2", {
      resourceEntries: [makeDocumentResource("x"), makeDocumentResource("y")],
    });

    const result = composeResources(primary, [fg1, fg2]);
    expect(result.map((r) => r.slug)).toEqual(["x", "y"]);
  });
});

// ---------------------------------------------------------------------------
// Empty foregrounds — all compose functions return primary-only
// ---------------------------------------------------------------------------

describe("empty foregrounds return primary-only context unchanged", () => {
  it("composeWorkspaceSections returns primary string", () => {
    const primary = "<workspace>primary</workspace>";
    expect(composeWorkspaceSections(primary, [])).toBe(primary);
  });

  it("composeSkills returns same array reference", () => {
    const primary = [makeSkill({ skillId: "s1" })];
    expect(composeSkills(primary, [])).toBe(primary);
  });

  it("composeTools returns same object reference", () => {
    const primary: AtlasTools = { t: makeTool("test") };
    expect(composeTools(primary, [])).toBe(primary);
  });

  it("composeResources returns same array reference", () => {
    const primary = [makeDocumentResource("r1")];
    expect(composeResources(primary, [])).toBe(primary);
  });
});
