import type { MCPServerConfig, WorkspaceConfig } from "@atlas/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServerMetadata } from "./schemas.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockDiscoverMCPServers = vi.hoisted(() => vi.fn());

vi.mock("./discovery.ts", () => ({
  discoverMCPServers: (...args: unknown[]) => mockDiscoverMCPServers(...args),
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { findServerReferences } from "@atlas/config/mutations";
import { getWorkspaceMCPStatus } from "./workspace-mcp.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStaticServer(id: string, config: Partial<MCPServerMetadata> = {}): MCPServerMetadata {
  return {
    id,
    name: id,
    source: "static",
    securityRating: "high",
    configTemplate: { transport: { type: "stdio", command: "echo", args: ["hello"] } },
    ...config,
  } as MCPServerMetadata;
}

function makeRegistryServer(
  id: string,
  config: Partial<MCPServerMetadata> = {},
): MCPServerMetadata {
  return {
    id,
    name: id,
    source: "registry",
    securityRating: "medium",
    configTemplate: { transport: { type: "stdio", command: "echo", args: ["hello"] } },
    ...config,
  } as MCPServerMetadata;
}

function makeWorkspaceConfig(servers: Record<string, MCPServerConfig>): WorkspaceConfig {
  return {
    version: "1.0",
    workspace: { name: "test", description: "test" },
    tools: {
      mcp: {
        client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
        servers,
      },
    },
  } as unknown as WorkspaceConfig;
}

// ---------------------------------------------------------------------------
// findServerReferences
// ---------------------------------------------------------------------------

describe("findServerReferences", () => {
  it("finds no references in an empty config", () => {
    const config = makeWorkspaceConfig({});
    const refs = findServerReferences(config, "github");
    expect(refs.agentIds).toEqual([]);
    expect(refs.jobIds).toEqual([]);
  });

  it("finds a top-level LLM agent that references the server", () => {
    const config = {
      ...makeWorkspaceConfig({}),
      agents: {
        "repo-agent": {
          type: "llm",
          description: "Repo agent",
          config: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            prompt: "You manage repos",
            temperature: 0,
            tools: ["github", "linear"],
          },
        },
      },
    } as WorkspaceConfig;

    const refs = findServerReferences(config, "github");
    expect(refs.agentIds).toEqual(["repo-agent"]);
    expect(refs.jobIds).toEqual([]);
  });

  it("ignores non-LLM agents", () => {
    const config = {
      ...makeWorkspaceConfig({}),
      agents: {
        "system-agent": { type: "system", description: "System agent", agent: "claude-code" },
      },
    } as WorkspaceConfig;

    const refs = findServerReferences(config, "github");
    expect(refs.agentIds).toEqual([]);
    expect(refs.jobIds).toEqual([]);
  });

  it("finds multiple LLM agents referencing the same server", () => {
    const config = {
      ...makeWorkspaceConfig({}),
      agents: {
        a1: {
          type: "llm",
          description: "A1",
          config: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            prompt: "p1",
            temperature: 0,
            tools: ["github"],
          },
        },
        a2: {
          type: "llm",
          description: "A2",
          config: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            prompt: "p2",
            temperature: 0,
            tools: ["github", "slack"],
          },
        },
      },
    } as WorkspaceConfig;

    const refs = findServerReferences(config, "github");
    expect(refs.agentIds.sort()).toEqual(["a1", "a2"]);
  });

  it("finds an FSM job step that references the server", () => {
    const config = {
      ...makeWorkspaceConfig({}),
      jobs: {
        "research-job": {
          name: "research",
          fsm: {
            id: "research-job",
            initial: "step_0",
            states: {
              step_0: {
                entry: [
                  {
                    type: "llm",
                    provider: "anthropic",
                    model: "claude-sonnet-4-6",
                    prompt: "Research",
                    temperature: 0,
                    tools: ["github"],
                  },
                ],
              },
            },
          },
        },
      },
    } as WorkspaceConfig;

    const refs = findServerReferences(config, "github");
    expect(refs.agentIds).toEqual([]);
    expect(refs.jobIds).toEqual(["research-job"]);
  });

  it("finds multiple FSM jobs referencing the same server", () => {
    const config = {
      ...makeWorkspaceConfig({}),
      jobs: {
        j1: {
          name: "j1",
          fsm: {
            id: "j1",
            initial: "s0",
            states: {
              s0: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    temperature: 0,
                    tools: ["github"],
                  },
                ],
              },
            },
          },
        },
        j2: {
          name: "j2",
          fsm: {
            id: "j2",
            initial: "s0",
            states: {
              s0: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    temperature: 0,
                    tools: ["github", "slack"],
                  },
                ],
              },
            },
          },
        },
      },
    } as WorkspaceConfig;

    const refs = findServerReferences(config, "github");
    expect(refs.jobIds.sort()).toEqual(["j1", "j2"]);
  });

  it("ignores non-llm FSM actions", () => {
    const config = {
      ...makeWorkspaceConfig({}),
      jobs: {
        "agent-job": {
          name: "agent-job",
          fsm: {
            id: "agent-job",
            initial: "s0",
            states: { s0: { entry: [{ type: "agent", agentId: "claude-code" }] } },
          },
        },
      },
    } as WorkspaceConfig;

    const refs = findServerReferences(config, "github");
    expect(refs.jobIds).toEqual([]);
  });

  it("deduplicates job IDs when multiple states reference the same server", () => {
    const config = {
      ...makeWorkspaceConfig({}),
      jobs: {
        "multi-state": {
          name: "multi-state",
          fsm: {
            id: "multi-state",
            initial: "s0",
            states: {
              s0: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    temperature: 0,
                    tools: ["github"],
                  },
                ],
              },
              s1: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    temperature: 0,
                    tools: ["github"],
                  },
                ],
              },
            },
          },
        },
      },
    } as WorkspaceConfig;

    const refs = findServerReferences(config, "github");
    expect(refs.jobIds).toEqual(["multi-state"]);
  });

  it("returns both agent and job references", () => {
    const config = {
      ...makeWorkspaceConfig({}),
      agents: {
        a1: {
          type: "llm",
          description: "A1",
          config: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            prompt: "p",
            temperature: 0,
            tools: ["github"],
          },
        },
      },
      jobs: {
        j1: {
          name: "j1",
          fsm: {
            id: "j1",
            initial: "s0",
            states: {
              s0: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    temperature: 0,
                    tools: ["github"],
                  },
                ],
              },
            },
          },
        },
      },
    } as WorkspaceConfig;

    const refs = findServerReferences(config, "github");
    expect(refs.agentIds).toEqual(["a1"]);
    expect(refs.jobIds).toEqual(["j1"]);
  });
});

// ---------------------------------------------------------------------------
// getWorkspaceMCPStatus
// ---------------------------------------------------------------------------

describe("getWorkspaceMCPStatus", () => {
  beforeEach(() => {
    mockDiscoverMCPServers.mockReset();
  });

  it("partitions into enabled and available", async () => {
    mockDiscoverMCPServers.mockResolvedValue([
      {
        metadata: makeStaticServer("github", { name: "GitHub" }),
        mergedConfig: {} as MCPServerConfig,
        configured: true,
      },
      {
        metadata: makeRegistryServer("linear", { name: "Linear" }),
        mergedConfig: {} as MCPServerConfig,
        configured: false,
      },
    ]);

    const config = makeWorkspaceConfig({
      github: { transport: { type: "stdio", command: "echo" } },
    });

    const status = await getWorkspaceMCPStatus("ws-1", config);

    expect(status.enabled).toHaveLength(1);
    expect(status.enabled[0]).toMatchObject({
      id: "github",
      name: "GitHub",
      source: "static",
      configured: true,
    });

    expect(status.available).toHaveLength(1);
    expect(status.available[0]).toMatchObject({
      id: "linear",
      name: "Linear",
      source: "registry",
      configured: false,
    });
  });

  it("includes workspace-only custom servers in enabled", async () => {
    mockDiscoverMCPServers.mockResolvedValue([
      {
        metadata: {
          id: "custom-1",
          name: "custom-1",
          source: "workspace",
          securityRating: "unverified",
          configTemplate: { transport: { type: "stdio", command: "echo" } },
        } as MCPServerMetadata,
        mergedConfig: { transport: { type: "stdio", command: "echo" } } as MCPServerConfig,
        configured: true,
      },
    ]);

    const config = makeWorkspaceConfig({
      "custom-1": { transport: { type: "stdio", command: "echo" } },
    });

    const status = await getWorkspaceMCPStatus("ws-1", config);

    expect(status.enabled).toHaveLength(1);
    expect(status.enabled[0]).toMatchObject({ id: "custom-1", source: "workspace" });
    expect(status.available).toHaveLength(0);
  });

  it("excludes workspace-only servers from available", async () => {
    mockDiscoverMCPServers.mockResolvedValue([
      {
        metadata: {
          id: "custom-1",
          name: "custom-1",
          source: "workspace",
          securityRating: "unverified",
          configTemplate: { transport: { type: "stdio", command: "echo" } },
        } as MCPServerMetadata,
        mergedConfig: { transport: { type: "stdio", command: "echo" } } as MCPServerConfig,
        configured: true,
      },
    ]);

    const config = makeWorkspaceConfig({});

    const status = await getWorkspaceMCPStatus("ws-1", config);

    expect(status.enabled).toHaveLength(0);
    expect(status.available).toHaveLength(0);
  });

  it("merges agent references into enabled servers", async () => {
    mockDiscoverMCPServers.mockResolvedValue([
      {
        metadata: makeStaticServer("github", { name: "GitHub" }),
        mergedConfig: {} as MCPServerConfig,
        configured: true,
      },
    ]);

    const config = {
      ...makeWorkspaceConfig({ github: { transport: { type: "stdio", command: "echo" } } }),
      agents: {
        a1: {
          type: "llm",
          description: "A1",
          config: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            prompt: "p",
            temperature: 0,
            tools: ["github"],
          },
        },
      },
    } as WorkspaceConfig;

    const status = await getWorkspaceMCPStatus("ws-1", config);

    expect(status.enabled[0]?.agentIds).toEqual(["a1"]);
    expect(status.enabled[0]?.jobIds).toBeUndefined();
  });

  it("merges job references into enabled servers", async () => {
    mockDiscoverMCPServers.mockResolvedValue([
      {
        metadata: makeStaticServer("github", { name: "GitHub" }),
        mergedConfig: {} as MCPServerConfig,
        configured: true,
      },
    ]);

    const config = {
      ...makeWorkspaceConfig({ github: { transport: { type: "stdio", command: "echo" } } }),
      jobs: {
        j1: {
          name: "j1",
          fsm: {
            id: "j1",
            initial: "s0",
            states: {
              s0: {
                entry: [
                  {
                    type: "llm",
                    provider: "openai",
                    model: "gpt-4",
                    prompt: "p",
                    temperature: 0,
                    tools: ["github"],
                  },
                ],
              },
            },
          },
        },
      },
    } as WorkspaceConfig;

    const status = await getWorkspaceMCPStatus("ws-1", config);

    expect(status.enabled[0]?.jobIds).toEqual(["j1"]);
    expect(status.enabled[0]?.agentIds).toBeUndefined();
  });

  it("returns empty arrays when no servers exist", async () => {
    mockDiscoverMCPServers.mockResolvedValue([]);

    const config = makeWorkspaceConfig({});
    const status = await getWorkspaceMCPStatus("ws-1", config);

    expect(status.enabled).toEqual([]);
    expect(status.available).toEqual([]);
  });

  it("passes workspaceConfig and linkSummary to discoverMCPServers", async () => {
    mockDiscoverMCPServers.mockResolvedValue([]);

    const config = makeWorkspaceConfig({});
    const linkSummary = { providers: [], credentials: [] };

    await getWorkspaceMCPStatus("ws-1", config, linkSummary);

    expect(mockDiscoverMCPServers).toHaveBeenCalledExactlyOnceWith("ws-1", config, linkSummary);
  });

  it("does not include agentIds or jobIds when empty", async () => {
    mockDiscoverMCPServers.mockResolvedValue([
      {
        metadata: makeStaticServer("github", { name: "GitHub" }),
        mergedConfig: {} as MCPServerConfig,
        configured: true,
      },
    ]);

    const config = makeWorkspaceConfig({
      github: { transport: { type: "stdio", command: "echo" } },
    });

    const status = await getWorkspaceMCPStatus("ws-1", config);

    expect(status.enabled[0]).not.toHaveProperty("agentIds");
    expect(status.enabled[0]).not.toHaveProperty("jobIds");
  });
});
