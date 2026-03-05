import type { AtlasUIMessage } from "@atlas/agent-sdk";
import type { smallLLM } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import type { SkillSummary } from "@atlas/skills";
import { describe, expect, it, vi } from "vitest";

vi.mock("@atlas/llm", async () => {
  const actual = await vi.importActual<typeof import("@atlas/llm")>("@atlas/llm");
  return { ...actual, smallLLM: vi.fn() };
});

import SYSTEM_PROMPT from "./prompt.txt" with { type: "text" };
import {
  buildSkillsSection,
  formatWorkspaceSection,
  generateChatTitle,
  getSystemPrompt,
} from "./workspace-chat.agent.ts";

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
  resources: Array<{ id: string; type: string; title: string; summary: string }>;
};

function makeDetails(overrides: Partial<WorkspaceDetails> = {}): WorkspaceDetails {
  return { name: "test-workspace", agents: [], jobs: [], signals: [], resources: [], ...overrides };
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

  it("renders resources section", () => {
    const result = formatWorkspaceSection(
      "ws-7",
      makeDetails({
        resources: [{ id: "r1", type: "document", title: "Readme", summary: "Project docs" }],
      }),
    );
    expect(result).toContain('<resource id="r1" type="document">Readme - Project docs</resource>');
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
        resources: [{ id: "r1", type: "file", title: "Config", summary: "App config" }],
      }),
    );

    expect(result).toMatch(/^<workspace id="ws-full" name="full-ws">/);
    expect(result).toContain("Everything included");
    expect(result).toContain("<agents>a1</agents>");
    expect(result).toContain("<jobs>\nbuild - Build all\n</jobs>");
    expect(result).toContain("<signals>push</signals>");
    expect(result).toContain('<resource id="r1" type="file">Config - App config</resource>');
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
      title: "Test Skill",
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
    const result = getSystemPrompt(workspaceSection, integrations);
    expect(result).toBe(`${SYSTEM_PROMPT}\n\n${workspaceSection}\n\n${integrations}`);
  });

  it("appends skills section when provided", () => {
    const skills = "<available_skills>deploy</available_skills>";
    const result = getSystemPrompt(workspaceSection, undefined, skills);
    expect(result).toBe(`${SYSTEM_PROMPT}\n\n${workspaceSection}\n\n${skills}`);
  });

  it("appends user identity section when provided", () => {
    const identity = "<user>alice</user>";
    const result = getSystemPrompt(workspaceSection, undefined, undefined, identity);
    expect(result).toBe(`${SYSTEM_PROMPT}\n\n${workspaceSection}\n\n${identity}`);
  });

  it("appends all optional sections in order", () => {
    const integrations = "<integrations>github</integrations>";
    const skills = "<available_skills>deploy</available_skills>";
    const identity = "<user>alice</user>";
    const result = getSystemPrompt(workspaceSection, integrations, skills, identity);
    expect(result).toBe(
      `${SYSTEM_PROMPT}\n\n${workspaceSection}\n\n${integrations}\n\n${skills}\n\n${identity}`,
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
    const title = await generateChatTitle(messages, logger);

    expect(title).toBe("Deploy Setup");
    expect(mock).toHaveBeenCalledOnce();
  });

  it("throws when LLM throws", async () => {
    const mock = await getMockedSmallLLM();
    mock.mockRejectedValueOnce(new Error("LLM unavailable"));

    const logger = makeLogger();
    const messages = [makeMessage("user", "Hello")];

    await expect(generateChatTitle(messages, logger)).rejects.toThrow("LLM unavailable");
  });

  it("returns 'Saved Chat' when LLM returns empty string", async () => {
    const mock = await getMockedSmallLLM();
    mock.mockResolvedValueOnce("");

    const logger = makeLogger();
    const messages = [makeMessage("user", "Hi")];
    const title = await generateChatTitle(messages, logger);

    expect(title).toBe("Saved Chat");
  });

  it("returns 'Saved Chat' when LLM returns whitespace-only string", async () => {
    const mock = await getMockedSmallLLM();
    mock.mockResolvedValueOnce("   ");

    const logger = makeLogger();
    const messages = [makeMessage("user", "Hmm")];
    const title = await generateChatTitle(messages, logger);

    expect(title).toBe("Saved Chat");
  });
});
