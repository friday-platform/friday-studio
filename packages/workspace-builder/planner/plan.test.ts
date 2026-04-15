import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before the module under test is imported
// ---------------------------------------------------------------------------

const mockGenerateObject = vi.hoisted(() => vi.fn());
const mockAdapterList = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({ generateObject: mockGenerateObject }));

vi.mock("@atlas/agent-sdk", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, repairJson: vi.fn((text: string) => text) };
});

vi.mock("@atlas/bundled-agents", () => ({
  bundledAgents: [
    { metadata: { id: "slack" } },
    { metadata: { id: "research" } },
    { metadata: { id: "data-analyst" } },
  ],
}));

vi.mock("@atlas/core/mcp-registry/registry-consolidated", () => ({
  mcpServersRegistry: { servers: { github: { id: "github" }, notion: { id: "notion" } } },
}));

vi.mock("@atlas/core/mcp-registry/storage", () => ({
  getMCPRegistryAdapter: vi.fn(() => Promise.resolve({ list: mockAdapterList })),
}));

vi.mock("@atlas/llm", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getDefaultProviderOpts: vi.fn(() => ({})),
    temporalGroundingMessage: vi.fn(() => ({
      role: "system",
      content: "## Context Facts\n- Current Date: Tuesday, February 11, 2026",
    })),
  };
});

vi.mock("@atlas/logger", () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

vi.mock("../../system/agents/conversation/capabilities.ts", () => ({
  getCapabilitiesSection: vi.fn(() => "mock capabilities"),
}));

vi.mock("../../system/agents/conversation/link-context.ts", () => ({
  fetchLinkSummary: vi.fn(() => null),
  formatIntegrationsSection: vi.fn(() => ""),
}));

import { createStubPlatformModels } from "@atlas/llm";
import { generatePlan, getCapabilityIds, toKebabCase } from "./plan.ts";

const platformModels = createStubPlatformModels();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getCapabilityIds", () => {
  beforeEach(() => {
    mockAdapterList.mockReset();
  });

  it("merges bundled agent IDs and static MCP server IDs", async () => {
    mockAdapterList.mockResolvedValueOnce([]);

    const { ids } = await getCapabilityIds();

    expect(ids).toContain("slack");
    expect(ids).toContain("research");
    expect(ids).toContain("data-analyst");
    expect(ids).toContain("github");
    expect(ids).toContain("notion");
  });

  it("includes dynamic MCP server IDs", async () => {
    mockAdapterList.mockResolvedValueOnce([{ id: "custom-crm" }]);

    const { ids } = await getCapabilityIds();

    expect(ids).toContain("custom-crm");
  });

  it("deduplicates — static takes precedence over dynamic", async () => {
    // "github" exists in static MCP servers, also returned as dynamic
    mockAdapterList.mockResolvedValueOnce([{ id: "github" }, { id: "custom-tool" }]);

    const { ids } = await getCapabilityIds();

    const githubCount = ids.filter((id) => id === "github").length;
    expect(githubCount).toBe(1);
    expect(ids).toContain("custom-tool");
  });

  it("returns dynamic server metadata", async () => {
    const dynamic = [{ id: "custom-crm", name: "Custom CRM" }];
    mockAdapterList.mockResolvedValueOnce(dynamic);

    const { dynamicServers } = await getCapabilityIds();

    expect(dynamicServers).toEqual(dynamic);
  });

  it("falls back to static-only when dynamic storage fails", async () => {
    mockAdapterList.mockRejectedValueOnce(new Error("KV unavailable"));

    const { ids, dynamicServers } = await getCapabilityIds();

    // Should still have static IDs
    expect(ids).toContain("slack");
    expect(ids).toContain("github");
    expect(ids.length).toBe(5); // 3 bundled + 2 MCP
    expect(dynamicServers).toEqual([]);
  });

  it("throws when bundled agents and MCP registries are both empty", async () => {
    // Temporarily replace the mocked module internals with empty registries.
    // The vi.mock for @atlas/bundled-agents returns a fixed array and
    // @atlas/core/mcp-registry/registry-consolidated returns a fixed object,
    // so we re-mock them for this test only.
    const { bundledAgents } = await import("@atlas/bundled-agents");
    const { mcpServersRegistry } = await import("@atlas/core/mcp-registry/registry-consolidated");

    const originalBundled = [...bundledAgents];
    const originalServers = { ...mcpServersRegistry.servers };

    bundledAgents.length = 0;
    for (const key of Object.keys(mcpServersRegistry.servers)) {
      delete mcpServersRegistry.servers[key];
    }
    mockAdapterList.mockResolvedValueOnce([]);

    try {
      await expect(getCapabilityIds()).rejects.toThrow("No capability IDs found");
    } finally {
      bundledAgents.push(...originalBundled);
      Object.assign(mcpServersRegistry.servers, originalServers);
    }
  });
});

describe("toKebabCase", () => {
  it.each([
    // Special characters
    ["Digest Compiler & Email Sender", "digest-compiler-email-sender"],
    ["Dust.tt Researcher", "dust-tt-researcher"],
    ["Report (Weekly)", "report-weekly"],
    // NFKD-decomposable diacritics
    ["Résumé Analyzer", "resume-analyzer"],
    ["Ñoño Über Reporter", "nono-uber-reporter"],
    // Non-decomposable Latin characters (pre-NFKD map)
    ["Straße Monitor", "strasse-monitor"],
    ["Æthelred Øresund Łódź", "aethelred-oresund-lodz"],
    ["Þór ð Agent", "thor-d-agent"],
    ["Đào œuvre", "dao-oeuvre"],
    // Emoji (stripped, ASCII remains)
    ["🤖 News Bot", "news-bot"],
    // Invisible Unicode (stripped without inserting hyphens)
    ["News\u200BBot", "news-bot"],
    ["Data\u00ADAnalyzer", "data-analyzer"],
    ["\uFEFFReport Agent", "report-agent"],
    // Combined: invisible char inside a non-decomposable Latin word
    ["Stra\u200Bße Agent", "strasse-agent"],
    // camelCase splitting
    ["camelCase", "camel-case"],
    // Plain ASCII
    ["Simple Name", "simple-name"],
  ])("%s → %s", (input, expected) => {
    expect(toKebabCase(input)).toBe(expected);
  });
});

describe("generatePlan — mode parameter", () => {
  beforeEach(() => {
    mockGenerateObject.mockReset();
    mockAdapterList.mockReset();
    mockAdapterList.mockResolvedValue([]);
  });

  it("task mode returns empty signals and kebab-cased agent IDs", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        plan: {
          workspace: { name: "Test Task", purpose: "Analyze a CSV" },
          agents: [
            {
              name: "Data Analyst",
              description: "Analyzes CSV data",
              capabilities: ["data-analyst"],
            },
          ],
        },
      },
    });

    const result = await generatePlan(
      "Analyze this CSV file",
      { platformModels },
      { mode: "task" },
    );

    expect(result.signals).toEqual([]);
    expect(result.agents).toEqual([
      expect.objectContaining({ id: "data-analyst", name: "Data Analyst" }),
    ]);
    expect(result.workspace.name).toBe("Test Task");
  });

  it("task mode prompt excludes signal instructions", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { plan: { workspace: { name: "Test", purpose: "Test" }, agents: [] } },
    });

    await generatePlan("do something", { platformModels }, { mode: "task" });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("triggered ad-hoc"),
          }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Do not generate signals"),
          }),
        ]),
      }),
    );
    // Verify signal instructions are excluded
    expect(mockGenerateObject).not.toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining("Signal Types") }),
        ]),
      }),
    );
  });

  it("throws when agent name produces an empty ID after sanitization", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        plan: {
          workspace: { name: "Bad Plan", purpose: "Test" },
          agents: [{ name: "&&&", description: "All special chars", capabilities: [] }],
        },
      },
    });

    await expect(generatePlan("test", { platformModels }, { mode: "task" })).rejects.toThrow(
      'Name "&&&" produces an empty ID after sanitization',
    );
  });

  it("workspace mode returns signals and agents with kebab-cased IDs", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        plan: {
          workspace: { name: "PR Summary", purpose: "Summarize PRs weekly" },
          signals: [
            {
              name: "Weekly Check",
              title: "Triggers weekly on Friday",
              signalType: "schedule",
              description: "Runs every Friday at 9am",
              displayLabel: "Every Friday at 9am",
            },
          ],
          agents: [
            { name: "PR Reader", description: "Reads merged PRs", capabilities: ["github"] },
          ],
        },
      },
    });

    const result = await generatePlan("Summarize PRs weekly", { platformModels });

    expect(result.signals).toEqual([
      expect.objectContaining({ id: "weekly-check", name: "Weekly Check" }),
    ]);
    expect(result.agents).toEqual([
      expect.objectContaining({ id: "pr-reader", name: "PR Reader" }),
    ]);
  });

  it("workspace mode prompt includes Signal Types section", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { plan: { workspace: { name: "Test", purpose: "Test" }, signals: [], agents: [] } },
    });

    await generatePlan("do something", { platformModels }, { mode: "workspace" });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Signal Types"),
          }),
        ]),
      }),
    );
    // Verify task-only instructions are excluded
    expect(mockGenerateObject).not.toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining("triggered ad-hoc") }),
        ]),
      }),
    );
  });

  it("system prompt includes capability selection framing", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { plan: { workspace: { name: "Test", purpose: "Test" }, agents: [] } },
    });

    await generatePlan("do something", { platformModels }, { mode: "task" });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining(
              "Select capability IDs from the Capabilities section below",
            ),
          }),
        ]),
      }),
    );
  });
});

describe("generatePlan — resource declarations", () => {
  beforeEach(() => {
    mockGenerateObject.mockReset();
  });

  it("system prompt includes persistent state section", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        plan: {
          workspace: { name: "Test", purpose: "Test" },
          signals: [],
          agents: [],
          resources: [],
        },
      },
    });

    await generatePlan("build a meal planner", { platformModels }, { mode: "workspace" });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("persistent state"),
          }),
        ]),
      }),
    );
  });

  it("system prompt includes resource guidance", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        plan: {
          workspace: { name: "Test", purpose: "Test" },
          signals: [],
          agents: [],
          resources: [],
        },
      },
    });

    await generatePlan("build a meal planner", { platformModels }, { mode: "workspace" });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Persistent state (resources)"),
          }),
        ]),
      }),
    );
  });

  it("workspace mode returns resource declarations from LLM output", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        plan: {
          workspace: { name: "Meal Planner", purpose: "Plan meals and groceries" },
          signals: [
            {
              name: "Weekly Plan",
              title: "Triggers weekly",
              signalType: "schedule",
              description: "Every Sunday",
              displayLabel: "Every Sunday",
            },
          ],
          agents: [{ name: "Meal Agent", description: "Plans meals", needs: [] }],
          resources: [
            {
              slug: "grocery_list",
              name: "Grocery List",
              description: "Items to buy",
              schema: {
                type: "object",
                properties: { item: { type: "string" }, quantity: { type: "integer" } },
                required: ["item"],
              },
            },
            {
              slug: "recipes",
              name: "Recipes",
              description: "Saved recipes",
              schema: {
                type: "object",
                properties: { title: { type: "string" }, servings: { type: "integer" } },
                required: ["title"],
              },
            },
          ],
        },
      },
    });

    const result = await generatePlan("Build a meal planner", { platformModels });

    expect(result.resources).toHaveLength(2);
    expect(result.resources[0]).toEqual(
      expect.objectContaining({ slug: "grocery_list", name: "Grocery List" }),
    );
    expect(result.resources[1]).toEqual(
      expect.objectContaining({ slug: "recipes", name: "Recipes" }),
    );
  });

  it("returns empty resources array when LLM declares none", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        plan: {
          workspace: { name: "Notifier", purpose: "Send notifications" },
          signals: [
            {
              name: "Check",
              title: "Periodic check",
              signalType: "schedule",
              description: "Every hour",
              displayLabel: "Hourly",
            },
          ],
          agents: [{ name: "Notifier", description: "Sends alerts", needs: ["slack"] }],
          resources: [],
        },
      },
    });

    const result = await generatePlan("Send me Slack alerts when something happens", {
      platformModels,
    });

    expect(result.resources).toEqual([]);
  });

  it("task mode also returns resources", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        plan: {
          workspace: { name: "Data Import", purpose: "Import data" },
          agents: [{ name: "Importer", description: "Imports CSV", needs: ["data-analysis"] }],
          resources: [
            {
              slug: "contacts",
              name: "Contacts",
              description: "Imported contact records",
              schema: {
                type: "object",
                properties: { email: { type: "string" }, name: { type: "string" } },
                required: ["email"],
              },
            },
          ],
        },
      },
    });

    const result = await generatePlan(
      "Import my contacts CSV",
      { platformModels },
      { mode: "task" },
    );

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toEqual(
      expect.objectContaining({ slug: "contacts", name: "Contacts" }),
    );
  });

  it("includes external ref resources in output", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        plan: {
          workspace: { name: "Sheet Sync", purpose: "Sync with Google Sheets" },
          signals: [],
          agents: [{ name: "Syncer", description: "Syncs data", needs: ["google-sheets"] }],
          resources: [
            {
              slug: "budget_sheet",
              name: "Budget Sheet",
              description: "External Google Sheet for budget tracking",
              provider: "google-sheets",
            },
          ],
        },
      },
    });

    const result = await generatePlan(
      "Sync my budget with Google Sheets",
      { platformModels },
      { mode: "workspace" },
    );

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toEqual(
      expect.objectContaining({
        slug: "budget_sheet",
        name: "Budget Sheet",
        provider: "google-sheets",
      }),
    );
  });

  it("system prompt suppresses pure-CRUD jobs for resource-only workspaces", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        plan: {
          workspace: { name: "Test", purpose: "Test" },
          signals: [],
          agents: [],
          resources: [],
        },
      },
    });

    await generatePlan("track my food", { platformModels }, { mode: "workspace" });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Do NOT create jobs for basic resource operations"),
          }),
        ]),
      }),
    );
  });

  it("system prompt specifies what still gets jobs", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        plan: {
          workspace: { name: "Test", purpose: "Test" },
          signals: [],
          agents: [],
          resources: [],
        },
      },
    });

    await generatePlan("track my food", { platformModels }, { mode: "workspace" });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("External service integration"),
          }),
        ]),
      }),
    );
  });
});
