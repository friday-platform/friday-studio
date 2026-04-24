import type { LinkSummary, MCPServerCandidate } from "@atlas/core/mcp-registry/discovery";
import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createListMCPServersTool } from "./list-mcp-servers.ts";

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

function makeCandidate(
  overrides: Partial<MCPServerCandidate> & { metadata: { id: string; name: string } },
): MCPServerCandidate {
  return {
    metadata: {
      id: overrides.metadata.id,
      name: overrides.metadata.name,
      source: overrides.metadata.source ?? "static",
      securityRating: overrides.metadata.securityRating ?? "high",
      configTemplate: { transport: { type: "stdio", command: "echo" } },
      description: overrides.metadata.description,
      constraints: overrides.metadata.constraints,
    },
    mergedConfig: { transport: { type: "stdio", command: "echo" } },
    configured: overrides.configured ?? true,
  } satisfies MCPServerCandidate;
}

const TOOL_CALL_OPTS = {
  toolCallId: "tc-1",
  messages: [] as never[],
  abortSignal: new AbortController().signal,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createListMCPServersTool", () => {
  const logger = makeLogger();

  beforeEach(() => {
    mockDiscoverMCPServers.mockReset();
  });

  it("returns object with list_mcp_servers key", () => {
    const tools = createListMCPServersTool("ws-1", undefined, undefined, logger);
    expect(tools).toHaveProperty("list_mcp_servers");
    expect(tools.list_mcp_servers).toBeDefined();
  });

  it("returns all servers by default", async () => {
    const candidates: MCPServerCandidate[] = [
      makeCandidate({
        metadata: {
          id: "github",
          name: "GitHub",
          description: "GitHub integration",
        },
        configured: true,
      }),
      makeCandidate({
        metadata: {
          id: "slack",
          name: "Slack",
          description: "Slack integration",
        },
        configured: false,
      }),
    ];
    mockDiscoverMCPServers.mockResolvedValueOnce(candidates);

    const tools = createListMCPServersTool("ws-1", undefined, undefined, logger);
    const result = await tools.list_mcp_servers!.execute({}, TOOL_CALL_OPTS);

    expect(result).toEqual({
      servers: [
        {
          id: "github",
          name: "GitHub",
          description: "GitHub integration",
          source: "static",
          securityRating: "high",
          configured: true,
          constraints: undefined,
        },
        {
          id: "slack",
          name: "Slack",
          description: "Slack integration",
          source: "static",
          securityRating: "high",
          configured: false,
          constraints: undefined,
        },
      ],
      total: 2,
      configuredCount: 1,
    });
    expect(mockDiscoverMCPServers).toHaveBeenCalledWith("ws-1", undefined, undefined);
  });

  it("filters by configured", async () => {
    const candidates: MCPServerCandidate[] = [
      makeCandidate({
        metadata: { id: "github", name: "GitHub" },
        configured: true,
      }),
      makeCandidate({
        metadata: { id: "slack", name: "Slack" },
        configured: false,
      }),
    ];
    mockDiscoverMCPServers.mockResolvedValueOnce(candidates);

    const tools = createListMCPServersTool("ws-1", undefined, undefined, logger);
    const result = await tools.list_mcp_servers!.execute(
      { filter: "configured" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      servers: [
        {
          id: "github",
          name: "GitHub",
          source: "static",
          securityRating: "high",
          configured: true,
          description: undefined,
          constraints: undefined,
        },
      ],
      total: 2,
      configuredCount: 1,
    });
  });

  it("filters by unconfigured", async () => {
    const candidates: MCPServerCandidate[] = [
      makeCandidate({
        metadata: { id: "github", name: "GitHub" },
        configured: true,
      }),
      makeCandidate({
        metadata: { id: "slack", name: "Slack" },
        configured: false,
      }),
    ];
    mockDiscoverMCPServers.mockResolvedValueOnce(candidates);

    const tools = createListMCPServersTool("ws-1", undefined, undefined, logger);
    const result = await tools.list_mcp_servers!.execute(
      { filter: "unconfigured" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      servers: [
        {
          id: "slack",
          name: "Slack",
          source: "static",
          securityRating: "high",
          configured: false,
          description: undefined,
          constraints: undefined,
        },
      ],
      total: 2,
      configuredCount: 1,
    });
  });

  it("returns empty list when no servers exist", async () => {
    mockDiscoverMCPServers.mockResolvedValueOnce([]);

    const tools = createListMCPServersTool("ws-1", undefined, undefined, logger);
    const result = await tools.list_mcp_servers!.execute({}, TOOL_CALL_OPTS);

    expect(result).toEqual({ servers: [], total: 0, configuredCount: 0 });
  });

  it("passes workspaceConfig and linkSummary through to discoverMCPServers", async () => {
    const wsConfig = { workspace: { name: "test" } } as unknown as Parameters<
      typeof createListMCPServersTool
    >[1];
    const linkSummary: LinkSummary = {
      providers: [{ id: "github" }],
      credentials: [{ provider: "github" }],
    };

    mockDiscoverMCPServers.mockResolvedValueOnce([]);

    const tools = createListMCPServersTool("ws-1", wsConfig, linkSummary, logger);
    await tools.list_mcp_servers!.execute({}, TOOL_CALL_OPTS);

    expect(mockDiscoverMCPServers).toHaveBeenCalledWith("ws-1", wsConfig, linkSummary);
  });

  it("returns error when discoverMCPServers throws", async () => {
    mockDiscoverMCPServers.mockRejectedValueOnce(new Error("Network failure"));

    const tools = createListMCPServersTool("ws-1", undefined, undefined, logger);
    const result = await tools.list_mcp_servers!.execute({}, TOOL_CALL_OPTS);

    expect(result).toHaveProperty("error", "list_mcp_servers failed: Network failure");
    expect(logger.warn).toHaveBeenCalledWith(
      "list_mcp_servers failed",
      expect.objectContaining({ workspaceId: "ws-1", error: "Network failure" }),
    );
  });
});
