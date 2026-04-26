/**
 * Integration tests for workspace MCP daemon routes.
 *
 * Covers GET, PUT, and DELETE with workspace lookup, blueprint guards,
 * idempotent enable, conflict detection, and runtime teardown.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MCPServerConfig, WorkspaceConfig } from "@atlas/config";
import { stringify } from "@std/yaml";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createMergedConfig,
  createMockWorkspace,
  createTestConfig,
  useTempDir,
} from "./config.test-fixtures.ts";

// Mock storeWorkspaceHistory to avoid Cortex dependencies
vi.mock("@atlas/storage", () => ({ storeWorkspaceHistory: vi.fn().mockResolvedValue(undefined) }));

// Mock discoverMCPServers to control catalog contents without real registry
const mockDiscoverMCPServers = vi.hoisted(() => vi.fn());

vi.mock("@atlas/core/mcp-registry/discovery", () => ({
  discoverMCPServers: (...args: unknown[]) => mockDiscoverMCPServers(...args),
}));

// Import AFTER mock setup (vi.mock is hoisted)
const { mcpRoutes } = await import("./mcp.ts");

import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import type { AppContext, AppVariables } from "../../src/factory.ts";

type JsonBody = Record<string, unknown>;

function createTestApp(options: {
  workspace?: ReturnType<typeof createMockWorkspace> | null;
  config?: ReturnType<typeof createMergedConfig> | null;
  runtimeActive?: boolean;
}) {
  const { workspace = createMockWorkspace(), config = null, runtimeActive = false } = options;

  const destroyWorkspaceRuntime = vi.fn().mockResolvedValue(undefined);
  const getWorkspaceRuntime = vi.fn().mockReturnValue(runtimeActive ? {} : undefined);

  const mockWorkspaceManager = {
    find: vi.fn().mockResolvedValue(workspace),
    getWorkspaceConfig: vi.fn().mockResolvedValue(config),
    list: vi.fn().mockResolvedValue([]),
    registerWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
  } as unknown as WorkspaceManager;

  const mockContext: AppContext = {
    runtimes: new Map(),
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: () => mockWorkspaceManager,
    getOrCreateWorkspaceRuntime: vi.fn(),
    resetIdleTimeout: vi.fn(),
    getWorkspaceRuntime,
    destroyWorkspaceRuntime,
    getLibraryStorage: vi.fn(),
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    evictChatSdkInstance: vi.fn(),
    getLedgerAdapter: vi.fn(),
    getActivityAdapter: vi.fn(),
    daemon: {} as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
  };

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    await next();
  });
  app.route("/:workspaceId/mcp", mcpRoutes);

  return { app, mockContext, destroyWorkspaceRuntime, getWorkspaceRuntime };
}

function makeWorkspaceConfig(servers: Record<string, MCPServerConfig>): WorkspaceConfig {
  return {
    version: "1.0",
    workspace: { id: "test-workspace", name: "Test Workspace" },
    tools: {
      mcp: {
        client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
        servers,
      },
    },
  } as unknown as WorkspaceConfig;
}

function makeCandidate(id: string, name: string, source: "static" | "registry" | "workspace") {
  return {
    metadata: {
      id,
      name,
      source,
      securityRating: "high" as const,
      configTemplate: { transport: { type: "stdio", command: "echo" } as MCPServerConfig },
    },
    mergedConfig: { transport: { type: "stdio", command: "echo" } } as MCPServerConfig,
    configured: true,
  };
}

// =============================================================================
// GET /api/workspaces/:workspaceId/mcp
// =============================================================================

describe("GET /mcp", () => {
  beforeEach(() => {
    mockDiscoverMCPServers.mockReset();
  });

  test("returns 404 when workspace not found", async () => {
    const { app } = createTestApp({ workspace: null, config: null });

    const res = await app.request("/ws-unknown/mcp");

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body).toMatchObject({ error: "not_found", entityType: "workspace" });
  });

  test("returns enabled and available partition", async () => {
    mockDiscoverMCPServers.mockResolvedValue([
      makeCandidate("github", "GitHub", "static"),
      makeCandidate("linear", "Linear", "registry"),
    ]);

    const config = makeWorkspaceConfig({
      github: { transport: { type: "stdio", command: "echo" } },
    });
    const { app } = createTestApp({ config: createMergedConfig(config) });

    const res = await app.request("/ws-test-id/mcp");

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.enabled).toHaveLength(1);
    expect(body.enabled[0]).toMatchObject({ id: "github", name: "GitHub", source: "static" });
    expect(body.available).toHaveLength(1);
    expect(body.available[0]).toMatchObject({ id: "linear", name: "Linear", source: "registry" });
  });

  test("excludes workspace-only servers from available", async () => {
    mockDiscoverMCPServers.mockResolvedValue([makeCandidate("custom-1", "Custom 1", "workspace")]);

    const config = makeWorkspaceConfig({});
    const { app } = createTestApp({ config: createMergedConfig(config) });

    const res = await app.request("/ws-test-id/mcp");

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.enabled).toHaveLength(0);
    expect(body.available).toHaveLength(0);
  });

  test("passes workspaceConfig explicitly to discoverMCPServers", async () => {
    mockDiscoverMCPServers.mockResolvedValue([]);

    const config = makeWorkspaceConfig({});
    const { app } = createTestApp({ config: createMergedConfig(config) });

    await app.request("/ws-test-id/mcp");

    expect(mockDiscoverMCPServers).toHaveBeenCalledWith("ws-test-id", config, undefined);
  });
});

// =============================================================================
// PUT /api/workspaces/:workspaceId/mcp/:serverId
// =============================================================================

describe("PUT /mcp/:serverId", () => {
  const getTestDir = useTempDir();

  beforeEach(() => {
    mockDiscoverMCPServers.mockReset();
  });

  test("returns 404 when workspace not found", async () => {
    const { app } = createTestApp({ workspace: null, config: null });

    const res = await app.request("/ws-unknown/mcp/github", { method: "PUT" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body).toMatchObject({ error: "not_found", entityType: "workspace" });
  });

  test("returns 403 for system workspace", async () => {
    const workspace = createMockWorkspace({ metadata: { system: true } });
    const { app } = createTestApp({ workspace, config: createMergedConfig(createTestConfig()) });

    const res = await app.request("/ws-test-id/mcp/github", { method: "PUT" });

    expect(res.status).toBe(403);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("forbidden");
  });

  test("returns 422 for blueprint workspace", async () => {
    const workspace = createMockWorkspace({ metadata: { blueprintArtifactId: "art-1" } });
    const { app } = createTestApp({ workspace, config: createMergedConfig(createTestConfig()) });

    const res = await app.request("/ws-test-id/mcp/github", { method: "PUT" });

    expect(res.status).toBe(422);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("not_supported");
    expect(body.message).toContain("blueprint");
  });

  test("returns 404 when server not in catalog", async () => {
    mockDiscoverMCPServers.mockResolvedValue([]);

    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const config = makeWorkspaceConfig({});
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app } = createTestApp({ workspace, config: createMergedConfig(config) });

    const res = await app.request("/ws-test-id/mcp/github", { method: "PUT" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body).toMatchObject({
      error: "not_found",
      entityType: "mcp server",
      entityId: "github",
    });
  });

  test("returns 200 idempotently when server already enabled", async () => {
    mockDiscoverMCPServers.mockResolvedValue([makeCandidate("github", "GitHub", "static")]);

    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const config = makeWorkspaceConfig({
      github: { transport: { type: "stdio", command: "echo" } },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app, destroyWorkspaceRuntime } = createTestApp({
      workspace,
      config: createMergedConfig(config),
    });

    const res = await app.request("/ws-test-id/mcp/github", { method: "PUT" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.server).toMatchObject({ id: "github", name: "GitHub" });
    // Idempotent success should not destroy runtime or rewrite config
    expect(destroyWorkspaceRuntime).not.toHaveBeenCalled();
  });

  test("enables a server and destroys runtime", async () => {
    mockDiscoverMCPServers.mockResolvedValue([makeCandidate("github", "GitHub", "static")]);

    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const config = makeWorkspaceConfig({});
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app, destroyWorkspaceRuntime } = createTestApp({
      workspace,
      config: createMergedConfig(config),
      runtimeActive: true,
    });

    const res = await app.request("/ws-test-id/mcp/github", { method: "PUT" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.server).toMatchObject({ id: "github", name: "GitHub" });
    expect(destroyWorkspaceRuntime).toHaveBeenCalledWith("ws-test-id");
  });
});

// =============================================================================
// DELETE /api/workspaces/:workspaceId/mcp/:serverId
// =============================================================================

describe("DELETE /mcp/:serverId", () => {
  const getTestDir = useTempDir();

  beforeEach(() => {
    mockDiscoverMCPServers.mockReset();
  });

  test("returns 404 when workspace not found", async () => {
    const { app } = createTestApp({ workspace: null, config: null });

    const res = await app.request("/ws-unknown/mcp/github", { method: "DELETE" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body).toMatchObject({ error: "not_found", entityType: "workspace" });
  });

  test("returns 403 for system workspace", async () => {
    const workspace = createMockWorkspace({ metadata: { system: true } });
    const { app } = createTestApp({ workspace, config: createMergedConfig(createTestConfig()) });

    const res = await app.request("/ws-test-id/mcp/github", { method: "DELETE" });

    expect(res.status).toBe(403);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("forbidden");
  });

  test("returns 422 for blueprint workspace", async () => {
    const workspace = createMockWorkspace({ metadata: { blueprintArtifactId: "art-1" } });
    const { app } = createTestApp({ workspace, config: createMergedConfig(createTestConfig()) });

    const res = await app.request("/ws-test-id/mcp/github", { method: "DELETE" });

    expect(res.status).toBe(422);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("not_supported");
    expect(body.message).toContain("blueprint");
  });

  test("returns 404 when server not enabled", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const config = makeWorkspaceConfig({});
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app } = createTestApp({ workspace, config: createMergedConfig(config) });

    const res = await app.request("/ws-test-id/mcp/github", { method: "DELETE" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as JsonBody;
    expect(body).toMatchObject({
      error: "not_found",
      entityType: "mcp server",
      entityId: "github",
    });
  });

  test("disables a server and destroys runtime", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const config = makeWorkspaceConfig({
      github: { transport: { type: "stdio", command: "echo" } },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app, destroyWorkspaceRuntime } = createTestApp({
      workspace,
      config: createMergedConfig(config),
      runtimeActive: true,
    });

    const res = await app.request("/ws-test-id/mcp/github", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.removed).toBe("github");
    expect(destroyWorkspaceRuntime).toHaveBeenCalledWith("ws-test-id");
  });

  test("returns 409 when server referenced by agent without force", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
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
            tools: ["github"],
          },
        },
      },
    } as WorkspaceConfig;
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app, destroyWorkspaceRuntime } = createTestApp({
      workspace,
      config: createMergedConfig(config),
      runtimeActive: true,
    });

    const res = await app.request("/ws-test-id/mcp/github", { method: "DELETE" });

    expect(res.status).toBe(409);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("conflict");
    expect(body.willUnlinkFrom).toEqual([{ type: "agent", agentId: "a1" }]);
    expect(destroyWorkspaceRuntime).not.toHaveBeenCalled();
  });

  test("cascades delete with force=true", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
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
            tools: ["github"],
          },
        },
      },
    } as WorkspaceConfig;
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app, destroyWorkspaceRuntime } = createTestApp({
      workspace,
      config: createMergedConfig(config),
      runtimeActive: true,
    });

    const res = await app.request("/ws-test-id/mcp/github?force=true", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.removed).toBe("github");
    expect(destroyWorkspaceRuntime).toHaveBeenCalledWith("ws-test-id");
  });
});
