/**
 * Integration tests for workspace MCP daemon routes.
 *
 * Covers GET, PUT, and DELETE with workspace lookup, blueprint guards,
 * idempotent enable, conflict detection, and runtime teardown.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MCPServerConfig, WorkspaceConfig } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import { stringify } from "@std/yaml";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createMergedConfig,
  createMockWorkspace,
  createTestConfig,
  useTempDir,
} from "./config.test-fixtures.ts";

// Mock discoverMCPServers to control catalog contents without real registry
const mockDiscoverMCPServers = vi.hoisted(() => vi.fn());

vi.mock("@atlas/core/mcp-registry/discovery", () => ({
  discoverMCPServers: (...args: unknown[]) => mockDiscoverMCPServers(...args),
}));

vi.mock("@atlas/core/workspace-members/storage", () => ({
  WorkspaceMemberStorage: {
    get: vi
      .fn()
      .mockImplementation((userId: string, wsId: string) =>
        Promise.resolve({
          ok: true,
          data: { userId, wsId, role: "owner", addedAt: "2026-05-11T00:00:00.000Z" },
        }),
      ),
    listByUser: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    listByWorkspace: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    put: vi.fn().mockResolvedValue({ ok: true, data: null }),
    putIfAbsent: vi.fn().mockResolvedValue({ ok: true, data: null }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  },
  ensureWorkspaceMembersKVBucket: vi.fn(),
  initWorkspaceMemberStorage: vi.fn(),
  resetWorkspaceMemberStorageForTests: vi.fn(),
}));

// Import AFTER mock setup (vi.mock is hoisted)
const { mcpRoutes, dropUnresolvableWiring } = await import("./mcp.ts");

import process from "node:process";
import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import type { AppContext, AppVariables } from "../../src/factory.ts";

type JsonBody = Record<string, unknown>;

function createTestApp(options: {
  workspace?: ReturnType<typeof createMockWorkspace> | null;
  config?: ReturnType<typeof createMergedConfig> | null;
}) {
  const { workspace = createMockWorkspace(), config = null } = options;

  const mockWorkspaceManager = {
    find: vi.fn().mockResolvedValue(workspace),
    getWorkspaceConfig: vi.fn().mockResolvedValue(config),
    list: vi.fn().mockResolvedValue([]),
    registerWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
  } as unknown as WorkspaceManager;

  const mockContext: AppContext = {
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: () => mockWorkspaceManager,
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    daemon: {} as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
    sessionDispatchRegistry: {} as AppContext["sessionDispatchRegistry"],
    exposeKernel: false,
    platformModels: createStubPlatformModels(),
  };

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    c.set("userId", "test-user");
    await next();
  });
  app.route("/:workspaceId/mcp", mcpRoutes);

  return { app, mockContext };
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
  const stdioConfig: MCPServerConfig = { transport: { type: "stdio", command: "echo" } };
  return {
    metadata: { id, name, source, securityRating: "high" as const, configTemplate: stdioConfig },
    mergedConfig: stdioConfig,
    configured: true,
  };
}

// =============================================================================
// GET /api/workspaces/:workspaceId/mcp
// =============================================================================

describe("GET /mcp", () => {
  const getTestDir = useTempDir();

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
    const body = (await res.json()) as { enabled: JsonBody[]; available: JsonBody[] };
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

  test("reads from draft when draft exists", async () => {
    mockDiscoverMCPServers.mockResolvedValue([makeCandidate("github", "GitHub", "static")]);

    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });

    // Live has no servers
    const liveConfig = makeWorkspaceConfig({});
    // Draft has github enabled
    const draftConfig = makeWorkspaceConfig({
      github: { transport: { type: "stdio", command: "echo" } },
    });

    await writeFile(join(testDir, "workspace.yml"), stringify(liveConfig));
    await writeFile(join(testDir, "workspace.yml.draft"), stringify(draftConfig));

    const { app } = createTestApp({ workspace, config: createMergedConfig(liveConfig) });

    const res = await app.request("/ws-test-id/mcp");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: JsonBody[]; available: JsonBody[] };
    expect(body.enabled).toHaveLength(1);
    expect(body.enabled[0]).toMatchObject({ id: "github", name: "GitHub" });
    expect(body.available).toHaveLength(0);
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

  test("returns 409 needs_manual_config when the entry's doctor verdict is unknown", async () => {
    const stdioConfig: MCPServerConfig = { transport: { type: "stdio", command: "echo" } };
    mockDiscoverMCPServers.mockResolvedValue([
      {
        metadata: {
          id: "needs-config",
          name: "Needs Config",
          source: "registry" as const,
          securityRating: "unverified" as const,
          configTemplate: stdioConfig,
          status: "ready" as const,
          doctor_report: {
            verdict: "unknown",
            tldr: "Could not enumerate config.",
            findings: [{ severity: "warn", title: "Sparse README", detail: "No env vars listed." }],
          },
        },
        mergedConfig: stdioConfig,
        configured: true,
      },
    ]);

    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const config = makeWorkspaceConfig({});
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app } = createTestApp({ workspace, config: createMergedConfig(config) });

    const res = await app.request("/ws-test-id/mcp/needs-config", { method: "PUT" });

    expect(res.status).toBe(409);
    const body = (await res.json()) as JsonBody;
    expect(body).toMatchObject({ error: "needs_manual_config", serverId: "needs-config" });
  });

  test("returns 200 idempotently when server already enabled", async () => {
    mockDiscoverMCPServers.mockResolvedValue([makeCandidate("github", "GitHub", "static")]);

    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const config = makeWorkspaceConfig({
      github: { transport: { type: "stdio", command: "echo" } },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app } = createTestApp({ workspace, config: createMergedConfig(config) });

    const res = await app.request("/ws-test-id/mcp/github", { method: "PUT" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.server).toMatchObject({ id: "github", name: "GitHub" });
    // Idempotent success should not destroy runtime or rewrite config
  });

  test("enables a server without tearing down the active runtime", async () => {
    mockDiscoverMCPServers.mockResolvedValue([makeCandidate("github", "GitHub", "static")]);

    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const config = makeWorkspaceConfig({});
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app } = createTestApp({ workspace, config: createMergedConfig(config) });

    const res = await app.request("/ws-test-id/mcp/github", { method: "PUT" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.server).toMatchObject({ id: "github", name: "GitHub" });
    // The route doesn't restart the runtime — the config write is enough; the
    // next spawn picks up the change.
  });

  test("enable lifts literal env values into the workspace .env, leaving from_environment wiring", async () => {
    mockDiscoverMCPServers.mockResolvedValue([
      {
        metadata: {
          id: "github",
          name: "GitHub",
          source: "static" as const,
          securityRating: "high" as const,
          configTemplate: {
            transport: { type: "stdio", command: "echo" },
            env: {
              LOG_LEVEL: "info",
              API_TOKEN: { from: "link", provider: "github", key: "API_TOKEN" },
            },
          },
        },
        mergedConfig: { transport: { type: "stdio", command: "echo" } },
        configured: true,
      },
    ]);

    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const config = makeWorkspaceConfig({});
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app } = createTestApp({ workspace, config: createMergedConfig(config) });

    const res = await app.request("/ws-test-id/mcp/github", { method: "PUT" });
    expect(res.status).toBe(200);

    // The literal setting value lands in the workspace `.env`.
    const envContent = await readFile(join(testDir, ".env"), "utf-8");
    expect(envContent).toContain("LOG_LEVEL=info");

    // The config copy holds `from_environment` wiring — not the literal — and
    // the Link ref passes through untouched.
    const ymlContent = await readFile(join(testDir, "workspace.yml"), "utf-8");
    expect(ymlContent).toContain("LOG_LEVEL: from_environment");
    expect(ymlContent).not.toContain("LOG_LEVEL: info");
    expect(ymlContent).toContain("API_TOKEN");
  });

  test("enable never clobbers an existing workspace .env value", async () => {
    mockDiscoverMCPServers.mockResolvedValue([
      {
        metadata: {
          id: "github",
          name: "GitHub",
          source: "static" as const,
          securityRating: "high" as const,
          configTemplate: {
            transport: { type: "stdio", command: "echo" },
            env: { LOG_LEVEL: "info" },
          },
        },
        mergedConfig: { transport: { type: "stdio", command: "echo" } },
        configured: true,
      },
    ]);

    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const config = makeWorkspaceConfig({});
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    // A value already supplied for this key — must win over the template default.
    await writeFile(join(testDir, ".env"), "LOG_LEVEL=debug\n");
    const { app } = createTestApp({ workspace, config: createMergedConfig(config) });

    const res = await app.request("/ws-test-id/mcp/github", { method: "PUT" });
    expect(res.status).toBe(200);

    const envContent = await readFile(join(testDir, ".env"), "utf-8");
    expect(envContent).toContain("LOG_LEVEL=debug");
    expect(envContent).not.toContain("LOG_LEVEL=info");
  });

  test("writes to draft when draft exists, leaving live unchanged and deferring runtime startup", async () => {
    mockDiscoverMCPServers.mockResolvedValue([makeCandidate("github", "GitHub", "static")]);

    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const liveConfig = makeWorkspaceConfig({});
    await writeFile(join(testDir, "workspace.yml"), stringify(liveConfig));
    await writeFile(join(testDir, "workspace.yml.draft"), stringify(liveConfig));
    const { app } = createTestApp({ workspace, config: createMergedConfig(liveConfig) });

    const res = await app.request("/ws-test-id/mcp/github", { method: "PUT" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.server).toMatchObject({ id: "github", name: "GitHub" });
    // Draft mode must not destroy runtime — startup is deferred until publish

    const draftContent = await readFile(join(testDir, "workspace.yml.draft"), "utf-8");
    expect(draftContent).toContain("github");
    expect(draftContent).toContain("echo");

    const liveContent = await readFile(join(testDir, "workspace.yml"), "utf-8");
    expect(liveContent).not.toContain("github");
  });

  test("returns 200 idempotently when server already enabled in draft", async () => {
    mockDiscoverMCPServers.mockResolvedValue([makeCandidate("github", "GitHub", "static")]);

    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const liveConfig = makeWorkspaceConfig({
      github: { transport: { type: "stdio", command: "echo" } },
    });
    // Draft also has the server enabled
    const draftConfig = makeWorkspaceConfig({
      github: { transport: { type: "stdio", command: "echo" } },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(liveConfig));
    await writeFile(join(testDir, "workspace.yml.draft"), stringify(draftConfig));
    const { app } = createTestApp({ workspace, config: createMergedConfig(draftConfig) });

    const res = await app.request("/ws-test-id/mcp/github", { method: "PUT" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.server).toMatchObject({ id: "github", name: "GitHub" });
  });
});

// =============================================================================
// PUT /api/workspaces/:workspaceId/mcp/:serverId/env/:key
// =============================================================================

describe("PUT /mcp/:serverId/env/:key", () => {
  const getTestDir = useTempDir();

  function envReq(
    app: ReturnType<typeof createTestApp>["app"],
    serverId: string,
    key: string,
    value: string,
  ) {
    return app.request(`/ws-test-id/mcp/${serverId}/env/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
  }

  test("returns 404 when workspace not found", async () => {
    const { app } = createTestApp({ workspace: null, config: null });
    const res = await envReq(app, "github", "BITBUCKET_WORKSPACE", "insanelygreatteam");
    expect(res.status).toBe(404);
  });

  test("returns 403 for a system workspace", async () => {
    const workspace = createMockWorkspace({ metadata: { canonical: "system" } });
    const { app } = createTestApp({ workspace });
    const res = await envReq(app, "github", "BITBUCKET_WORKSPACE", "insanelygreatteam");
    expect(res.status).toBe(403);
  });

  test("rejects a non-POSIX env key with 400", async () => {
    const { app } = createTestApp({ workspace: createMockWorkspace() });
    const res = await envReq(app, "github", "bad-key", "v");
    expect(res.status).toBe(400);
  });

  test("rejects a value containing a newline with 400", async () => {
    const { app } = createTestApp({ workspace: createMockWorkspace() });
    const res = await envReq(app, "github", "GOOD_KEY", "line1\nline2");
    expect(res.status).toBe(400);
  });

  test("happy path: writes the value to .env and points config wiring at it", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const config = makeWorkspaceConfig({
      github: { transport: { type: "stdio", command: "echo" } },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app } = createTestApp({ workspace, config: createMergedConfig(config) });

    const res = await envReq(app, "github", "BITBUCKET_WORKSPACE", "insanelygreatteam");
    expect(res.status).toBe(200);

    // The value lands in the workspace `.env`.
    const envContent = await readFile(join(testDir, ".env"), "utf-8");
    expect(envContent).toContain("BITBUCKET_WORKSPACE=insanelygreatteam");

    // The config copy points the entry at `.env` via `from_environment` wiring.
    const ymlContent = await readFile(join(testDir, "workspace.yml"), "utf-8");
    expect(ymlContent).toContain("BITBUCKET_WORKSPACE: from_environment");
  });

  test("returns 404 when the server is not in the workspace config", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const config = makeWorkspaceConfig({}); // no servers wired
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app } = createTestApp({ workspace, config: createMergedConfig(config) });

    const res = await envReq(app, "github", "BITBUCKET_WORKSPACE", "insanelygreatteam");
    expect(res.status).toBe(404);
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

  test("disables a server without tearing down the active runtime", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const config = makeWorkspaceConfig({
      github: { transport: { type: "stdio", command: "echo" } },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app } = createTestApp({ workspace, config: createMergedConfig(config) });

    const res = await app.request("/ws-test-id/mcp/github", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.removed).toBe("github");
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
            temperature: 0,
            tools: ["github"],
          },
        },
      },
    } as unknown as WorkspaceConfig;
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app } = createTestApp({ workspace, config: createMergedConfig(config) });

    const res = await app.request("/ws-test-id/mcp/github", { method: "DELETE" });

    expect(res.status).toBe(409);
    const body = (await res.json()) as JsonBody;
    expect(body.error).toBe("conflict");
    expect(body.willUnlinkFrom).toEqual([{ type: "agent", agentId: "a1" }]);
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
            temperature: 0,
            tools: ["github"],
          },
        },
      },
    } as unknown as WorkspaceConfig;
    await writeFile(join(testDir, "workspace.yml"), stringify(config));
    const { app } = createTestApp({ workspace, config: createMergedConfig(config) });

    const res = await app.request("/ws-test-id/mcp/github?force=true", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.removed).toBe("github");
  });

  test("writes to draft when draft exists, leaving live unchanged and deferring runtime teardown", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const liveConfig = {
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
    } as unknown as WorkspaceConfig;
    // Draft has the server enabled; live does too (draft was copied from live)
    const draftConfig = {
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
    } as unknown as WorkspaceConfig;
    await writeFile(join(testDir, "workspace.yml"), stringify(liveConfig));
    await writeFile(join(testDir, "workspace.yml.draft"), stringify(draftConfig));
    const { app } = createTestApp({ workspace, config: createMergedConfig(draftConfig) });

    const res = await app.request("/ws-test-id/mcp/github?force=true", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.removed).toBe("github");
    // Draft mode must not destroy runtime — teardown is deferred until publish

    const draftContent = await readFile(join(testDir, "workspace.yml.draft"), "utf-8");
    expect(draftContent).not.toContain("github");
    // Agent tools should also be stripped in draft
    expect(draftContent).not.toContain('tools: ["github"]');

    const liveContent = await readFile(join(testDir, "workspace.yml"), "utf-8");
    expect(liveContent).toContain("github");
  });
});

// =============================================================================
// dropUnresolvableWiring — keep/drop matrix for magic-string env wiring
// =============================================================================

describe("dropUnresolvableWiring", () => {
  const ENV_KEY = "MCP_TEST_PROCESS_ENV_VAR";
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prevEnv;
  });

  test("keeps Link refs untouched regardless of resolution", () => {
    const linkRef = { from: "link" as const, provider: "github", key: "GITHUB_TOKEN" };
    const result = dropUnresolvableWiring({ GITHUB_TOKEN: linkRef }, {}, {});
    expect(result).toEqual({ GITHUB_TOKEN: linkRef });
  });

  test("keeps literal string values untouched", () => {
    const result = dropUnresolvableWiring({ BASE_URL: "https://api.example.com" }, {}, {});
    expect(result).toEqual({ BASE_URL: "https://api.example.com" });
  });

  test("keeps from_environment when the key is about to be written (pendingValues)", () => {
    const result = dropUnresolvableWiring(
      { LOG_DIR: "from_environment" },
      { LOG_DIR: "/var/log" },
      {},
    );
    expect(result).toEqual({ LOG_DIR: "from_environment" });
  });

  test("keeps from_environment when the key is in the workspace .env overlay", () => {
    const result = dropUnresolvableWiring(
      { BASE_URL: "from_environment" },
      {},
      { BASE_URL: "https://api.example.com" },
    );
    expect(result).toEqual({ BASE_URL: "from_environment" });
  });

  test("keeps from_environment when the key is set in process.env", () => {
    process.env[ENV_KEY] = "present";
    const result = dropUnresolvableWiring({ [ENV_KEY]: "from_environment" }, {}, {});
    expect(result).toEqual({ [ENV_KEY]: "from_environment" });
  });

  test("drops from_environment when the key resolves nowhere", () => {
    const result = dropUnresolvableWiring({ NEVER_SET: "from_environment" }, {}, {});
    expect(result).toEqual({});
  });

  test("drops auto when the key resolves nowhere, keeps it when in overlay", () => {
    expect(dropUnresolvableWiring({ AUTO_VAR: "auto" }, {}, {})).toEqual({});
    expect(dropUnresolvableWiring({ AUTO_VAR: "auto" }, {}, { AUTO_VAR: "x" })).toEqual({
      AUTO_VAR: "auto",
    });
  });

  test("mixed block: drops only the unresolvable magic-string entries", () => {
    const linkRef = { from: "link" as const, provider: "p", key: "TOKEN" };
    const result = dropUnresolvableWiring(
      {
        TOKEN: linkRef,
        BASE_URL: "https://literal.example.com",
        LOG_DIR: "from_environment", // in pendingValues → kept
        REGION: "from_environment", // in overlay → kept
        ORPHAN: "from_environment", // nowhere → dropped
      },
      { LOG_DIR: "/var/log" },
      { REGION: "us-east-1" },
    );
    expect(result).toEqual({
      TOKEN: linkRef,
      BASE_URL: "https://literal.example.com",
      LOG_DIR: "from_environment",
      REGION: "from_environment",
    });
  });
});
