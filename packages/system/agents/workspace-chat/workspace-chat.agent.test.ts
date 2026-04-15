import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { createStubPlatformModels, type smallLLM } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import type { ResourceEntry } from "@atlas/resources";
import type { SkillSummary } from "@atlas/skills";
import { describe, expect, it, vi } from "vitest";

vi.mock("@atlas/llm", async () => {
  const actual = await vi.importActual<typeof import("@atlas/llm")>("@atlas/llm");
  return { ...actual, smallLLM: vi.fn() };
});

import SYSTEM_PROMPT from "./prompt.txt" with { type: "text" };
import {
  type ArtifactSummary,
  buildSkillsSection,
  computeOrphanedArtifacts,
  formatWorkspaceSection,
  generateChatTitle,
  getSystemPrompt,
  parseArtifactSummaries,
  parseResourceEntries,
} from "./workspace-chat.agent.ts";

const stubPlatformModels = createStubPlatformModels();

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

type WorkspaceDetails = {
  name: string;
  description?: string;
  agents: string[];
  jobs: Array<{ id: string; name: string; description?: string }>;
  signals: Array<{ name: string }>;
  resourceEntries: ResourceEntry[];
  orphanedArtifacts: Array<{ id: string; type: string; title: string; summary: string }>;
};

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

function makeMessage(role: "user" | "assistant", text: string): AtlasUIMessage {
  return { id: crypto.randomUUID(), role, parts: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// formatWorkspaceSection
// ---------------------------------------------------------------------------
describe("formatWorkspaceSection", () => {
  it("renders minimal workspace with just name and empty arrays", () => {
    const result = formatWorkspaceSection("ws-1", makeDetails());
    expect(result).toBe('<workspace id="ws-1" name="test-workspace">\n</workspace>');
  });

  it("includes description when provided", () => {
    const result = formatWorkspaceSection("ws-2", makeDetails({ description: "A cool workspace" }));
    expect(result).toContain("A cool workspace");
    expect(result).toMatch(
      /^<workspace id="ws-2" name="test-workspace">\nA cool workspace\n<\/workspace>$/,
    );
  });

  it("renders agents section", () => {
    const result = formatWorkspaceSection("ws-3", makeDetails({ agents: ["agent-a", "agent-b"] }));
    expect(result).toContain("<agents>agent-a, agent-b</agents>");
  });

  it("renders jobs without descriptions", () => {
    const result = formatWorkspaceSection(
      "ws-4",
      makeDetails({ jobs: [{ id: "j1", name: "deploy" }] }),
    );
    expect(result).toContain("<jobs>\ndeploy\n</jobs>");
  });

  it("renders jobs with descriptions", () => {
    const result = formatWorkspaceSection(
      "ws-5",
      makeDetails({ jobs: [{ id: "j1", name: "deploy", description: "Ship it" }] }),
    );
    expect(result).toContain("<jobs>\ndeploy - Ship it\n</jobs>");
  });

  it("renders signals section", () => {
    const result = formatWorkspaceSection(
      "ws-6",
      makeDetails({ signals: [{ name: "webhook" }, { name: "cron" }] }),
    );
    expect(result).toContain("<signals>webhook, cron</signals>");
  });

  it("does not render resources XML block (handled separately via guidance)", () => {
    const result = formatWorkspaceSection("ws-7", makeDetails());
    expect(result).not.toContain("<resources>");
  });

  it("renders all sections together", () => {
    const result = formatWorkspaceSection(
      "ws-full",
      makeDetails({
        name: "full-ws",
        description: "Everything included",
        agents: ["a1"],
        jobs: [{ id: "j1", name: "build", description: "Build all" }],
        signals: [{ name: "push" }],
      }),
    );

    expect(result).toMatch(/^<workspace id="ws-full" name="full-ws">/);
    expect(result).toContain("Everything included");
    expect(result).toContain("<agents>a1</agents>");
    expect(result).toContain("<jobs>\nbuild - Build all\n</jobs>");
    expect(result).toContain("<signals>push</signals>");
    expect(result).not.toContain("<resources>");
    expect(result).toMatch(/<\/workspace>$/);
  });
});

// ---------------------------------------------------------------------------
// buildSkillsSection
// ---------------------------------------------------------------------------
describe("buildSkillsSection", () => {
  function makeSkill(overrides: Partial<SkillSummary> = {}): SkillSummary {
    return {
      id: "skill-1",
      skillId: "skill-1",
      namespace: "ns",
      name: "test-skill",
      description: "A test skill",
      disabled: false,
      latestVersion: 1,
      createdAt: new Date("2026-01-01"),
      ...overrides,
    };
  }

  it("returns empty string for empty array", () => {
    expect(buildSkillsSection([])).toBe("");
  });

  it("renders a single skill", () => {
    const result = buildSkillsSection([
      makeSkill({ namespace: "atlas", name: "deploy", description: "Deploy things" }),
    ]);

    expect(result).toContain("<available_skills>");
    expect(result).toContain("</available_skills>");
    expect(result).toContain('<skill name="@atlas/deploy">Deploy things</skill>');
    expect(result).toContain("Load skills with load_skill when task matches.");
  });

  it("renders multiple skills", () => {
    const result = buildSkillsSection([
      makeSkill({ namespace: "atlas", name: "deploy", description: "Deploy things" }),
      makeSkill({ namespace: "tools", name: "lint", description: "Lint code" }),
    ]);

    expect(result).toContain('<skill name="@atlas/deploy">Deploy things</skill>');
    expect(result).toContain('<skill name="@tools/lint">Lint code</skill>');
  });
});

// ---------------------------------------------------------------------------
// getSystemPrompt
// ---------------------------------------------------------------------------
describe("getSystemPrompt", () => {
  const workspaceSection = "<workspace>test</workspace>";

  it("includes system prompt and workspace section", () => {
    const result = getSystemPrompt(workspaceSection);
    expect(result).toContain(SYSTEM_PROMPT);
    expect(result).toContain(workspaceSection);
    expect(result).toBe(`${SYSTEM_PROMPT}\n\n${workspaceSection}`);
  });

  it("appends integrations section when provided", () => {
    const integrations = "<integrations>github</integrations>";
    const result = getSystemPrompt(workspaceSection, { integrations });
    expect(result).toBe(`${SYSTEM_PROMPT}\n\n${workspaceSection}\n\n${integrations}`);
  });

  it("appends skills section when provided", () => {
    const skills = "<available_skills>deploy</available_skills>";
    const result = getSystemPrompt(workspaceSection, { skills });
    expect(result).toBe(`${SYSTEM_PROMPT}\n\n${workspaceSection}\n\n${skills}`);
  });

  it("appends user identity section when provided", () => {
    const identity = "<user>alice</user>";
    const result = getSystemPrompt(workspaceSection, { userIdentity: identity });
    expect(result).toBe(`${SYSTEM_PROMPT}\n\n${workspaceSection}\n\n${identity}`);
  });

  it("appends resource section after workspace section", () => {
    const resources = "## Workspace Resources\n\nDocuments:\n- food_log: Daily food tracker.";
    const result = getSystemPrompt(workspaceSection, { resources });
    expect(result).toBe(`${SYSTEM_PROMPT}\n\n${workspaceSection}\n\n${resources}`);
  });

  it("appends all optional sections in order", () => {
    const integrations = "<integrations>github</integrations>";
    const skills = "<available_skills>deploy</available_skills>";
    const identity = "<user>alice</user>";
    const resources = "## Workspace Resources";
    const result = getSystemPrompt(workspaceSection, {
      integrations,
      skills,
      userIdentity: identity,
      resources,
    });
    expect(result).toBe(
      `${SYSTEM_PROMPT}\n\n${workspaceSection}\n\n${resources}\n\n${integrations}\n\n${skills}\n\n${identity}`,
    );
  });
});

// ---------------------------------------------------------------------------
// generateChatTitle
// ---------------------------------------------------------------------------
describe("generateChatTitle", () => {
  // Access the mocked smallLLM
  async function getMockedSmallLLM(): Promise<ReturnType<typeof vi.fn<typeof smallLLM>>> {
    const mod = await import("@atlas/llm");
    return mod.smallLLM as ReturnType<typeof vi.fn<typeof smallLLM>>;
  }

  it("returns trimmed LLM response", async () => {
    const mock = await getMockedSmallLLM();
    mock.mockResolvedValueOnce("  Deploy Setup  ");

    const logger = makeLogger();
    const messages = [makeMessage("user", "Help me deploy")];
    const title = await generateChatTitle(stubPlatformModels, messages, logger);

    expect(title).toBe("Deploy Setup");
    expect(mock).toHaveBeenCalledOnce();
  });

  it("throws when LLM throws", async () => {
    const mock = await getMockedSmallLLM();
    mock.mockRejectedValueOnce(new Error("LLM unavailable"));

    const logger = makeLogger();
    const messages = [makeMessage("user", "Hello")];

    await expect(generateChatTitle(stubPlatformModels, messages, logger)).rejects.toThrow(
      "LLM unavailable",
    );
  });

  it("returns 'Saved Chat' when LLM returns empty string", async () => {
    const mock = await getMockedSmallLLM();
    mock.mockResolvedValueOnce("");

    const logger = makeLogger();
    const messages = [makeMessage("user", "Hi")];
    const title = await generateChatTitle(stubPlatformModels, messages, logger);

    expect(title).toBe("Saved Chat");
  });

  it("returns 'Saved Chat' when LLM returns whitespace-only string", async () => {
    const mock = await getMockedSmallLLM();
    mock.mockResolvedValueOnce("   ");

    const logger = makeLogger();
    const messages = [makeMessage("user", "Hmm")];
    const title = await generateChatTitle(stubPlatformModels, messages, logger);

    expect(title).toBe("Saved Chat");
  });
});

// ---------------------------------------------------------------------------
// parseResourceEntries
// ---------------------------------------------------------------------------
describe("parseResourceEntries", () => {
  const ts = "2026-03-01T00:00:00Z";

  it("parses document entries", () => {
    const data = {
      resources: [
        {
          type: "document",
          slug: "log",
          name: "Log",
          description: "A log",
          createdAt: ts,
          updatedAt: ts,
        },
      ],
    };
    const entries = parseResourceEntries(data);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      type: "document",
      slug: "log",
      name: "Log",
      description: "A log",
      createdAt: ts,
      updatedAt: ts,
    });
  });

  it("parses external_ref entries", () => {
    const data = {
      resources: [
        {
          type: "external_ref",
          slug: "sheet",
          name: "Sheet",
          description: "Spreadsheet",
          provider: "google",
          ref: "abc123",
          createdAt: ts,
          updatedAt: ts,
        },
      ],
    };
    const entries = parseResourceEntries(data);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "external_ref", slug: "sheet", provider: "google" });
  });

  it("parses artifact_ref entries with canonical artifact types", () => {
    const data = {
      resources: [
        {
          type: "artifact_ref",
          slug: "plan",
          name: "Plan",
          description: "Workspace plan",
          artifactId: "art-1",
          artifactType: "workspace-plan",
          createdAt: ts,
          updatedAt: ts,
        },
      ],
    };
    const entries = parseResourceEntries(data);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "artifact_ref", artifactType: "workspace-plan" });
  });

  it("parses artifact_ref entries with 'unavailable' type", () => {
    const data = {
      resources: [
        {
          type: "artifact_ref",
          slug: "x",
          name: "X",
          description: "Missing",
          artifactId: "art-2",
          artifactType: "unavailable",
          createdAt: ts,
          updatedAt: ts,
        },
      ],
    };
    const entries = parseResourceEntries(data);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "artifact_ref", artifactType: "unavailable" });
  });

  it("parses mixed entry types", () => {
    const data = {
      resources: [
        {
          type: "document",
          slug: "doc",
          name: "Doc",
          description: "D",
          createdAt: ts,
          updatedAt: ts,
        },
        {
          type: "external_ref",
          slug: "ext",
          name: "Ext",
          description: "E",
          provider: "notion",
          createdAt: ts,
          updatedAt: ts,
        },
        {
          type: "artifact_ref",
          slug: "art",
          name: "Art",
          description: "A",
          artifactId: "a1",
          artifactType: "table",
          createdAt: ts,
          updatedAt: ts,
        },
      ],
    };
    const entries = parseResourceEntries(data);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.type)).toEqual(["document", "external_ref", "artifact_ref"]);
  });

  it("returns empty array for invalid data", () => {
    expect(parseResourceEntries(null)).toEqual([]);
    expect(parseResourceEntries({})).toEqual([]);
    expect(parseResourceEntries({ resources: "not-array" })).toEqual([]);
  });

  it("returns empty array when individual entries have invalid shape", () => {
    const data = { resources: [{ type: "document" }] };
    expect(parseResourceEntries(data)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseArtifactSummaries
// ---------------------------------------------------------------------------
describe("parseArtifactSummaries", () => {
  it("parses valid artifact summaries", () => {
    const data = {
      artifacts: [
        { id: "a1", type: "table", title: "Sales", summary: "Sales data" },
        { id: "a2", type: "file", title: "Report", summary: "Monthly report" },
      ],
    };
    const summaries = parseArtifactSummaries(data);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toEqual({
      id: "a1",
      type: "table",
      title: "Sales",
      summary: "Sales data",
    });
  });

  it("returns empty array for invalid data", () => {
    expect(parseArtifactSummaries(null)).toEqual([]);
    expect(parseArtifactSummaries({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeOrphanedArtifacts
// ---------------------------------------------------------------------------
describe("computeOrphanedArtifacts", () => {
  const ts = "2026-03-01T00:00:00Z";

  function makeArtifact(id: string): ArtifactSummary {
    return { id, type: "table", title: `Artifact ${id}`, summary: "desc" };
  }

  it("returns all artifacts when no resource entries exist", () => {
    const artifacts = [makeArtifact("a1"), makeArtifact("a2")];
    const orphans = computeOrphanedArtifacts([], artifacts);
    expect(orphans).toEqual(artifacts);
  });

  it("returns all artifacts when no artifact_ref entries exist", () => {
    const entries: ResourceEntry[] = [
      {
        type: "document",
        slug: "doc",
        name: "Doc",
        description: "D",
        createdAt: ts,
        updatedAt: ts,
      },
    ];
    const artifacts = [makeArtifact("a1")];
    const orphans = computeOrphanedArtifacts(entries, artifacts);
    expect(orphans).toEqual(artifacts);
  });

  it("excludes artifacts linked via artifact_ref", () => {
    const entries: ResourceEntry[] = [
      {
        type: "artifact_ref",
        slug: "linked",
        name: "Linked",
        description: "L",
        artifactId: "a1",
        artifactType: "table",
        createdAt: ts,
        updatedAt: ts,
      },
    ];
    const artifacts = [makeArtifact("a1"), makeArtifact("a2")];
    const orphans = computeOrphanedArtifacts(entries, artifacts);
    expect(orphans).toEqual([makeArtifact("a2")]);
  });

  it("returns empty array when all artifacts are linked", () => {
    const entries: ResourceEntry[] = [
      {
        type: "artifact_ref",
        slug: "s1",
        name: "S1",
        description: "D",
        artifactId: "a1",
        artifactType: "table",
        createdAt: ts,
        updatedAt: ts,
      },
      {
        type: "artifact_ref",
        slug: "s2",
        name: "S2",
        description: "D",
        artifactId: "a2",
        artifactType: "file",
        createdAt: ts,
        updatedAt: ts,
      },
    ];
    const artifacts = [makeArtifact("a1"), makeArtifact("a2")];
    const orphans = computeOrphanedArtifacts(entries, artifacts);
    expect(orphans).toEqual([]);
  });

  it("returns empty array when no artifacts exist", () => {
    const orphans = computeOrphanedArtifacts([], []);
    expect(orphans).toEqual([]);
  });
});
