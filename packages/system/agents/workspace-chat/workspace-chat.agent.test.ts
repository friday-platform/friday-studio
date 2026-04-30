import type { AtlasTools, AtlasUIMessage } from "@atlas/agent-sdk";
import { bundledAgents } from "@atlas/bundled-agents";
import { createStubPlatformModels, type smallLLM } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import type { ResourceEntry } from "@atlas/resources";
import type { SkillSummary } from "@atlas/skills";
import type { UIMessageStreamWriter } from "ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@atlas/llm", async () => {
  const actual = await vi.importActual<typeof import("@atlas/llm")>("@atlas/llm");
  return { ...actual, smallLLM: vi.fn() };
});

import SYSTEM_PROMPT from "./prompt.txt" with { type: "text" };
import { createAgentTool } from "./tools/bundled-agent-tools.ts";
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

  it("renders signals section without config", () => {
    const result = formatWorkspaceSection(
      "ws-6",
      makeDetails({ signals: [{ name: "webhook" }, { name: "cron" }] }),
    );
    expect(result).toContain("<signals>\nwebhook\ncron\n</signals>");
  });

  it("inlines HTTP signal paths when config is provided", () => {
    // Regression: knowledge-base workspace has signals save/retrieve with
    // HTTP paths /webhook/kb-save / /webhook/kb-retrieve. Without this,
    // Friday told users to check Docker envs instead of pointing at the
    // actual webhook path.
    const result = formatWorkspaceSection(
      "kb",
      makeDetails({ signals: [{ name: "save" }, { name: "retrieve" }] }),
      {
        version: "1.0",
        workspace: {
          name: "kb",
          signals: {
            save: { provider: "http", config: { path: "/webhook/kb-save" } },
            retrieve: { provider: "http", config: { path: "/webhook/kb-retrieve" } },
          },
        },
      } as never,
    );
    expect(result).toContain("save (POST /webhook/kb-save)");
    expect(result).toContain("retrieve (POST /webhook/kb-retrieve)");
  });

  it("inlines cron schedule triggers when config is provided", () => {
    const result = formatWorkspaceSection("cron-ws", makeDetails({ signals: [{ name: "tick" }] }), {
      version: "1.0",
      workspace: {
        name: "cron-ws",
        signals: { tick: { provider: "schedule", config: { cron: "*/5 * * * *" } } },
      },
    } as never);
    expect(result).toContain("tick (cron */5 * * * *)");
  });

  it("does not render resources XML block (handled separately via guidance)", () => {
    const result = formatWorkspaceSection("ws-7", makeDetails());
    expect(result).not.toContain("<resources>");
  });

  it("omits communicators block when config has no communicators", () => {
    const result = formatWorkspaceSection("ws-no-comms", makeDetails(), {
      version: "1.0",
      workspace: { name: "ws-no-comms" },
    } as never);
    expect(result).not.toContain("<communicators>");
  });

  it("omits communicators block when config is undefined", () => {
    const result = formatWorkspaceSection("ws-no-config", makeDetails());
    expect(result).not.toContain("<communicators>");
  });

  it("renders all 5 kinds with wired=false when communicators is empty object", () => {
    const result = formatWorkspaceSection("ws-empty-comms", makeDetails(), {
      version: "1.0",
      workspace: { name: "ws-empty-comms" },
      communicators: {},
    } as never);
    expect(result).toContain(
      "<communicators>\n" +
        '<communicator kind="slack" wired="false"/>\n' +
        '<communicator kind="telegram" wired="false"/>\n' +
        '<communicator kind="discord" wired="false"/>\n' +
        '<communicator kind="teams" wired="false"/>\n' +
        '<communicator kind="whatsapp" wired="false"/>\n' +
        "</communicators>",
    );
  });

  it("marks one wired communicator and the rest unwired", () => {
    const result = formatWorkspaceSection("ws-one-wired", makeDetails(), {
      version: "1.0",
      workspace: { name: "ws-one-wired" },
      communicators: { telegram: { kind: "telegram" } },
    } as never);
    expect(result).toContain('<communicator kind="telegram" wired="true"/>');
    expect(result).toContain('<communicator kind="slack" wired="false"/>');
    expect(result).toContain('<communicator kind="discord" wired="false"/>');
    expect(result).toContain('<communicator kind="teams" wired="false"/>');
    expect(result).toContain('<communicator kind="whatsapp" wired="false"/>');
  });

  it("marks two wired communicators", () => {
    const result = formatWorkspaceSection("ws-two-wired", makeDetails(), {
      version: "1.0",
      workspace: { name: "ws-two-wired" },
      communicators: { slack: { kind: "slack" }, telegram: { kind: "telegram" } },
    } as never);
    expect(result).toContain('<communicator kind="slack" wired="true"/>');
    expect(result).toContain('<communicator kind="telegram" wired="true"/>');
    expect(result).toContain('<communicator kind="discord" wired="false"/>');
    expect(result).toContain('<communicator kind="teams" wired="false"/>');
    expect(result).toContain('<communicator kind="whatsapp" wired="false"/>');
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
    expect(result).toContain("<signals>\npush\n</signals>");
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
          artifactType: "file",
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
        artifactType: "file",
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
        artifactType: "file",
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

// ---------------------------------------------------------------------------
// primaryTools composition — bundled agents + delegate + no do_task
// ---------------------------------------------------------------------------
describe("primaryTools composition (Wave 3c)", () => {
  /** Build an env dict that satisfies every bundled agent's required keys. */
  function envSatisfyingAllAgents(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const agent of bundledAgents) {
      for (const field of agent.environmentConfig?.required ?? []) {
        env[field.name] = "stub-value";
      }
    }
    return env;
  }

  function makeDeps(env: Record<string, string>) {
    const writeFn = vi.fn();
    return {
      writer: { write: writeFn } as unknown as UIMessageStreamWriter<AtlasUIMessage>,
      session: { sessionId: "s1", workspaceId: "w1" },
      platformModels: stubPlatformModels,
      abortSignal: undefined,
      env,
      logger: makeLogger(),
    };
  }

  it("spread of createAgentTool(agent, deps) registers agent_<id> for every bundled agent when env satisfies required keys", () => {
    const deps = makeDeps(envSatisfyingAllAgents());
    const bundledAgentTools: AtlasTools = Object.assign(
      {},
      ...bundledAgents.map((agent) => createAgentTool(agent, deps)),
    );

    for (const agent of bundledAgents) {
      expect(bundledAgentTools).toHaveProperty(`agent_${agent.metadata.id}`);
    }
  });

  it("spread of createAgentTool omits agents whose required env keys are missing", () => {
    const deps = makeDeps({});
    const bundledAgentTools: AtlasTools = Object.assign(
      {},
      ...bundledAgents.map((agent) => createAgentTool(agent, deps)),
    );

    const agentsWithRequiredKeys = bundledAgents.filter(
      (a) => (a.environmentConfig?.required?.length ?? 0) > 0,
    );
    for (const agent of agentsWithRequiredKeys) {
      expect(bundledAgentTools).not.toHaveProperty(`agent_${agent.metadata.id}`);
    }
  });
});

// ---------------------------------------------------------------------------
// System prompt — ranking rubric, no do_task
// ---------------------------------------------------------------------------
describe("system prompt ranking rubric", () => {
  // Vitest does not honor the `with { type: "text" }` import attribute, so
  // `SYSTEM_PROMPT` resolves to the path string, not the file content. Read
  // the file directly so content-level assertions run against the real text.
  async function readPromptText(): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const url = new URL("./prompt.txt", import.meta.url);
    return readFile(fileURLToPath(url), "utf8");
  }

  it("prompt.txt contains direct-tools → agent_* → delegate ordering", async () => {
    const prompt = await readPromptText();
    expect(prompt).toMatch(/Prefer direct tools.*agent_\*.*delegate/s);
  });

  it("prompt.txt mentions both delegate and agent_* tools", async () => {
    const prompt = await readPromptText();
    expect(prompt).toContain("agent_*");
    expect(prompt).toContain("delegate");
  });

  it("prompt.txt does not contain do_task references", async () => {
    const prompt = await readPromptText();
    expect(prompt).not.toContain("do_task");
  });

  it("prompt.txt contains MCP workflow instructions", async () => {
    const prompt = await readPromptText();
    expect(prompt).toContain("list_capabilities");
    expect(prompt).toContain("mcpServers");
  });
});
