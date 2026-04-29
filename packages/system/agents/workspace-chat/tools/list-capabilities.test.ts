import { bundledAgents, bundledAgentsRegistry, webAgent } from "@atlas/bundled-agents";
import { type WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import type { LinkSummary, MCPServerCandidate } from "@atlas/core/mcp-registry/discovery";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createListCapabilitiesTool, ListCapabilitiesResultSchema } from "./list-capabilities.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockDiscoverMCPServers = vi.hoisted(() =>
  vi.fn<(workspaceId: string, ...args: unknown[]) => Promise<MCPServerCandidate[]>>(),
);

vi.mock("@atlas/core/mcp-registry/discovery", () => ({
  discoverMCPServers: mockDiscoverMCPServers,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeCandidate(overrides: {
  metadata: Partial<MCPServerMetadata> & { id: string; name: string };
  mergedConfig?: MCPServerCandidate["mergedConfig"];
  configured?: boolean;
}): MCPServerCandidate {
  return {
    metadata: {
      id: overrides.metadata.id,
      name: overrides.metadata.name,
      source: overrides.metadata.source ?? "static",
      securityRating: overrides.metadata.securityRating ?? "high",
      configTemplate: overrides.metadata.configTemplate ?? {
        transport: { type: "stdio", command: "echo" },
      },
      description: overrides.metadata.description,
      constraints: overrides.metadata.constraints,
    },
    mergedConfig: overrides.mergedConfig ?? { transport: { type: "stdio", command: "echo" } },
    configured: overrides.configured ?? true,
  } satisfies MCPServerCandidate;
}

function makeWorkspaceConfig(enabledServerIds: string[] = []): WorkspaceConfig {
  const servers = Object.fromEntries(
    enabledServerIds.map((id) => [id, { transport: { type: "stdio", command: "echo" } }]),
  );
  return WorkspaceConfigSchema.parse({
    version: "1.0",
    workspace: { name: "test", id: "ws-1" },
    tools: { mcp: { servers } },
  });
}

const TOOL_CALL_OPTS = {
  toolCallId: "tc-1",
  messages: [] as never[],
  abortSignal: new AbortController().signal,
};

async function runTool(
  tools: ReturnType<typeof createListCapabilitiesTool>,
  input: { workspaceId?: string } = {},
) {
  const tool = tools.list_capabilities;
  if (!tool?.execute) throw new Error("list_capabilities tool is missing execute");
  const raw = await tool.execute(input, TOOL_CALL_OPTS);
  return ListCapabilitiesResultSchema.parse(raw);
}

const logger = makeLogger();

beforeEach(() => {
  mockDiscoverMCPServers.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createListCapabilitiesTool", () => {
  it("returns object with list_capabilities key", () => {
    const tools = createListCapabilitiesTool("ws-1", makeWorkspaceConfig(), undefined, logger);
    expect(tools).toHaveProperty("list_capabilities");
    expect(tools.list_capabilities).toBeDefined();
  });

  it("returns bundled entries before mcp entries", async () => {
    mockDiscoverMCPServers.mockResolvedValueOnce([
      makeCandidate({ metadata: { id: "github", name: "GitHub" }, configured: true }),
    ]);

    const tools = createListCapabilitiesTool(
      "ws-1",
      makeWorkspaceConfig(["github"]),
      undefined,
      logger,
    );
    const result = await runTool(tools);

    if ("error" in result) throw new Error("expected success result");

    const firstMcpIdx = result.capabilities.findIndex((c) => c.kind !== "bundled");
    const lastBundledIdx =
      result.capabilities.length -
      1 -
      [...result.capabilities].reverse().findIndex((c) => c.kind === "bundled");

    expect(firstMcpIdx).toBeGreaterThan(lastBundledIdx);
  });

  it("orders bundled entries alphabetically by id", async () => {
    mockDiscoverMCPServers.mockResolvedValueOnce([]);

    const tools = createListCapabilitiesTool("ws-1", makeWorkspaceConfig(), undefined, logger);
    const result = await runTool(tools);

    if ("error" in result) throw new Error("expected success result");

    const bundledIds = result.capabilities.filter((c) => c.kind === "bundled").map((c) => c.id);
    const sorted = [...bundledIds].sort((a, b) => a.localeCompare(b));
    expect(bundledIds).toEqual(sorted);
  });

  it("orders mcp_enabled before mcp_available, alphabetical within each", async () => {
    mockDiscoverMCPServers.mockResolvedValueOnce([
      makeCandidate({ metadata: { id: "zulip", name: "Zulip" }, configured: true }),
      makeCandidate({ metadata: { id: "github", name: "GitHub" }, configured: true }),
      makeCandidate({ metadata: { id: "playwright", name: "Playwright" }, configured: true }),
      makeCandidate({ metadata: { id: "asana", name: "Asana" }, configured: true }),
    ]);

    const tools = createListCapabilitiesTool(
      "ws-1",
      makeWorkspaceConfig(["zulip", "github"]), // enabled set
      undefined,
      logger,
    );
    const result = await runTool(tools);

    if ("error" in result) throw new Error("expected success result");

    const mcpEntries = result.capabilities.filter((c) => c.kind !== "bundled");
    const kinds = mcpEntries.map((c) => c.kind);
    expect(kinds).toEqual(["mcp_enabled", "mcp_enabled", "mcp_available", "mcp_available"]);

    const enabledIds = mcpEntries.filter((c) => c.kind === "mcp_enabled").map((c) => c.id);
    expect(enabledIds).toEqual(["github", "zulip"]);

    const availableIds = mcpEntries.filter((c) => c.kind === "mcp_available").map((c) => c.id);
    expect(availableIds).toEqual(["asana", "playwright"]);
  });

  it("filters out alias bundled ids (browser, research)", async () => {
    mockDiscoverMCPServers.mockResolvedValueOnce([]);

    const tools = createListCapabilitiesTool("ws-1", makeWorkspaceConfig(), undefined, logger);
    const result = await runTool(tools);

    if ("error" in result) throw new Error("expected success result");

    const bundledIds = result.capabilities.filter((c) => c.kind === "bundled").map((c) => c.id);

    expect(bundledIds).not.toContain("browser");
    expect(bundledIds).not.toContain("research");
    expect(bundledIds).toContain("web");
    expect(bundledIds.length).toBe(bundledAgents.length);
  });

  it("returns only bundled entries when workspace has zero MCP servers", async () => {
    mockDiscoverMCPServers.mockResolvedValueOnce([]);

    const tools = createListCapabilitiesTool("ws-1", makeWorkspaceConfig(), undefined, logger);
    const result = await runTool(tools);

    if ("error" in result) throw new Error("expected success result");

    const kinds = new Set(result.capabilities.map((c) => c.kind));
    expect(kinds).toEqual(new Set(["bundled"]));
  });

  it("returns structured 404 error when workspaceId is invalid", async () => {
    mockDiscoverMCPServers.mockRejectedValueOnce(
      new Error("Failed to fetch workspace config: 404 Not Found"),
    );

    const tools = createListCapabilitiesTool("ws-bogus", undefined, undefined, logger);
    const result = await runTool(tools);

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.code).toBe("not_found");
    expect(result.error).toMatch(/ws-bogus/);
  });

  it("every variant carries requiresConfig as a string array", async () => {
    mockDiscoverMCPServers.mockResolvedValueOnce([
      makeCandidate({
        metadata: { id: "github", name: "GitHub" },
        configured: false,
        mergedConfig: {
          transport: { type: "stdio", command: "echo" },
          env: { GITHUB_TOKEN: "your-github-token" },
        },
      }),
      makeCandidate({ metadata: { id: "asana", name: "Asana" }, configured: true }),
    ]);

    const tools = createListCapabilitiesTool(
      "ws-1",
      makeWorkspaceConfig(["github"]),
      undefined,
      logger,
    );
    const result = await runTool(tools);

    if ("error" in result) throw new Error("expected success result");

    for (const c of result.capabilities) {
      expect(Array.isArray(c.requiresConfig)).toBe(true);
      for (const k of c.requiresConfig) expect(typeof k).toBe("string");
    }
  });

  it("sets requiresConfig to empty array when configured", async () => {
    mockDiscoverMCPServers.mockResolvedValueOnce([
      makeCandidate({ metadata: { id: "asana", name: "Asana" }, configured: true }),
    ]);

    const tools = createListCapabilitiesTool(
      "ws-1",
      makeWorkspaceConfig(["asana"]),
      undefined,
      logger,
    );
    const result = await runTool(tools);

    if ("error" in result) throw new Error("expected success result");

    const asana = result.capabilities.find((c) => c.id === "asana");
    expect(asana).toBeDefined();
    expect(asana?.requiresConfig).toEqual([]);
  });

  it("populates requiresConfig with unresolved string env keys for unconfigured mcp", async () => {
    mockDiscoverMCPServers.mockResolvedValueOnce([
      makeCandidate({
        metadata: { id: "slack", name: "Slack" },
        configured: false,
        mergedConfig: {
          transport: { type: "stdio", command: "echo" },
          env: { SLACK_TOKEN: "your-slack-token", SLACK_CHANNEL: "general" },
        },
      }),
    ]);

    const tools = createListCapabilitiesTool(
      "ws-1",
      makeWorkspaceConfig(["slack"]),
      undefined,
      logger,
    );
    const result = await runTool(tools);

    if ("error" in result) throw new Error("expected success result");

    const slack = result.capabilities.find((c) => c.id === "slack" && c.kind === "mcp_enabled");
    expect(slack).toBeDefined();
    expect(slack?.requiresConfig).toContain("SLACK_TOKEN");
  });

  it("derives mcp_available provider from LinkCredentialRef when present", async () => {
    mockDiscoverMCPServers.mockResolvedValueOnce([
      makeCandidate({
        metadata: { id: "github", name: "GitHub", source: "static" },
        configured: false,
        mergedConfig: {
          transport: { type: "stdio", command: "echo" },
          env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "token" } },
        },
      }),
    ]);

    const tools = createListCapabilitiesTool("ws-1", makeWorkspaceConfig(), undefined, logger);
    const result = await runTool(tools);

    if ("error" in result) throw new Error("expected success result");

    const github = result.capabilities.find((c) => c.id === "github" && c.kind === "mcp_available");
    expect(github).toBeDefined();
    if (github?.kind !== "mcp_available") throw new Error("expected mcp_available");
    expect(github.provider).toBe("github");
  });

  it("falls back to metadata.source for mcp_available provider when no Link env", async () => {
    mockDiscoverMCPServers.mockResolvedValueOnce([
      makeCandidate({
        metadata: { id: "asana", name: "Asana", source: "registry" },
        configured: true,
      }),
    ]);

    const tools = createListCapabilitiesTool("ws-1", makeWorkspaceConfig(), undefined, logger);
    const result = await runTool(tools);

    if ("error" in result) throw new Error("expected success result");

    const asana = result.capabilities.find((c) => c.id === "asana" && c.kind === "mcp_available");
    expect(asana).toBeDefined();
    if (asana?.kind !== "mcp_available") throw new Error("expected mcp_available");
    expect(asana.provider).toBe("registry");
  });

  it("sources bundled examples and constraints from agent metadata", async () => {
    mockDiscoverMCPServers.mockResolvedValueOnce([]);

    const tools = createListCapabilitiesTool("ws-1", makeWorkspaceConfig(), undefined, logger);
    const result = await runTool(tools);

    if ("error" in result) throw new Error("expected success result");

    const web = result.capabilities.find((c) => c.id === "web" && c.kind === "bundled");
    expect(web).toBeDefined();
    if (web?.kind !== "bundled") throw new Error("expected bundled");

    expect(web.examples).toEqual(webAgent.metadata.expertise.examples);
    expect(web.constraints).toBe(webAgent.metadata.constraints);
    expect(web.description).toBe(webAgent.metadata.description);
  });

  it("derives bundled requiresConfig from registry env field keys", async () => {
    mockDiscoverMCPServers.mockResolvedValueOnce([]);

    const tools = createListCapabilitiesTool("ws-1", makeWorkspaceConfig(), undefined, logger);
    const result = await runTool(tools);

    if ("error" in result) throw new Error("expected success result");

    const slackBundled = result.capabilities.find((c) => c.id === "slack" && c.kind === "bundled");
    expect(slackBundled).toBeDefined();
    if (slackBundled?.kind !== "bundled") throw new Error("expected bundled");

    const registryEntry = bundledAgentsRegistry.slack;
    if (!registryEntry) throw new Error("expected slack entry in bundledAgentsRegistry");
    const expectedKeys = registryEntry.requiredConfig.map((f) =>
      f.from === "env" ? f.key : f.envKey,
    );
    expect(slackBundled.requiresConfig).toEqual(expectedKeys);
  });

  it("passes workspaceConfig and linkSummary through to discoverMCPServers", async () => {
    const wsConfig = makeWorkspaceConfig();
    const linkSummary: LinkSummary = {
      providers: [{ id: "github" }],
      credentials: [{ provider: "github" }],
    };

    mockDiscoverMCPServers.mockResolvedValueOnce([]);

    const tools = createListCapabilitiesTool("ws-1", wsConfig, linkSummary, logger);
    await runTool(tools);

    expect(mockDiscoverMCPServers).toHaveBeenCalledWith("ws-1", wsConfig, linkSummary);
  });
});
