/**
 * Integration tests for POST /create (requires_setup flag) and
 * POST /:workspaceId/setup/complete endpoint.
 *
 * Tests the create endpoint sets requires_setup when credentials can't resolve,
 * and the setup/complete endpoint verifies all credentials before clearing the flag.
 */

import { createStubPlatformModels } from "@atlas/llm";
import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";

// Mock storage (FilesystemWorkspaceCreationAdapter used in create)
vi.mock("@atlas/storage", () => ({
  FilesystemWorkspaceCreationAdapter: class {
    createWorkspaceDirectory = vi.fn().mockResolvedValue("/tmp/test-ws");
    writeWorkspaceFiles = vi.fn().mockResolvedValue(undefined);
  },
}));

// Mock credential resolver
const mockResolveCredentialsByProvider = vi.hoisted(() => vi.fn());
const mockFetchLinkCredential = vi.hoisted(() => vi.fn());
vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>();
  return {
    ...original,
    resolveCredentialsByProvider: mockResolveCredentialsByProvider,
    fetchLinkCredential: mockFetchLinkCredential,
  };
});

// Mock getCurrentUser
vi.mock("../me/adapter.ts", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ ok: true, data: { id: "user-1" } }),
}));

// Mock writeFile used to update workspace config
const mockWriteFile = vi.hoisted(() =>
  vi.fn<(path: string, data: string | Uint8Array) => Promise<void>>().mockResolvedValue(undefined),
);
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, writeFile: mockWriteFile };
});

/** Minimal workspace config with a single MCP server that has a provider-only credential ref. */
function configWithProvider(provider: string) {
  return {
    version: "1.0",
    workspace: { name: "Test Workspace" },
    tools: {
      mcp: {
        servers: {
          myserver: {
            transport: { type: "stdio", command: "npx", args: ["-y", "some-server"] },
            env: { TOKEN: { from: "link", provider, key: "access_token" } },
          },
        },
      },
    },
  };
}

/** Config with two providers. */
function configWithTwoProviders(providerA: string, providerB: string) {
  return {
    version: "1.0",
    workspace: { name: "Test Workspace" },
    tools: {
      mcp: {
        servers: {
          serverA: {
            transport: { type: "stdio", command: "npx", args: ["-y", "server-a"] },
            env: { TOKEN_A: { from: "link", provider: providerA, key: "access_token" } },
          },
          serverB: {
            transport: { type: "stdio", command: "npx", args: ["-y", "server-b"] },
            env: { TOKEN_B: { from: "link", provider: providerB, key: "access_token" } },
          },
        },
      },
    },
  };
}

/** Config with no credential refs. */
function configWithNoCredentials() {
  return {
    version: "1.0",
    workspace: { name: "Test Workspace" },
    tools: {
      mcp: {
        servers: {
          myserver: { transport: { type: "stdio", command: "npx", args: ["-y", "some-server"] } },
        },
      },
    },
  };
}

/** Config where all credentials already have IDs (fully connected). */
function configWithConnectedCredentials() {
  return {
    version: "1.0",
    workspace: { name: "Test Workspace" },
    tools: {
      mcp: {
        servers: {
          github: {
            transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
            env: { TOKEN: { from: "link", id: "cred-1", provider: "github", key: "access_token" } },
          },
        },
      },
    },
  };
}

/** Config where some credentials are missing IDs. */
function configWithMissingCredentials() {
  return {
    version: "1.0",
    workspace: { name: "Test Workspace" },
    tools: {
      mcp: {
        servers: {
          github: {
            transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
            env: { TOKEN: { from: "link", provider: "github", key: "access_token" } },
          },
        },
      },
    },
  };
}

type JsonBody = Record<string, unknown>;

function createTestApp() {
  const updateWorkspaceStatus = vi.fn().mockResolvedValue(undefined);
  const registerWorkspace = vi
    .fn()
    .mockImplementation((_path: string, opts?: { name?: string }) => {
      const ws = {
        id: "ws-new-id",
        name: opts?.name ?? "Test Workspace",
        path: "/tmp/test-ws",
        configPath: "/tmp/test-ws/workspace.yml",
        status: "inactive" as const,
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        metadata: {},
      };
      return Promise.resolve({ workspace: ws, created: true });
    });

  // The default workspace config baseline mounts narrative stores from the
  // `user` workspace; the route validator (`workspaceList.has`) refuses
  // creation if a referenced workspace is unknown. Resolve `user` here so
  // tests don't trip the `unknown_mount_workspace` hard_fail.
  const find = vi.fn().mockImplementation(({ id }: { id: string }) => {
    if (id === "user") {
      return Promise.resolve({
        id: "user",
        name: "Personal",
        path: "/tmp/user-ws",
        configPath: "/tmp/user-ws/workspace.yml",
        status: "inactive" as const,
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        metadata: {},
      });
    }
    return Promise.resolve(null);
  });
  const getWorkspaceConfig = vi.fn();
  const handleWorkspaceConfigChange = vi.fn().mockResolvedValue(undefined);

  const mockWorkspaceManager = {
    find,
    getWorkspaceConfig,
    list: vi.fn().mockResolvedValue([]),
    registerWorkspace,
    deleteWorkspace: vi.fn(),
    updateWorkspaceStatus,
    handleWorkspaceConfigChange,
  } as unknown as WorkspaceManager;

  const mockContext: AppContext = {
    runtimes: new Map(),
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: () => mockWorkspaceManager,
    getOrCreateWorkspaceRuntime: vi.fn(),
    resetIdleTimeout: vi.fn(),
    getWorkspaceRuntime: vi.fn(),
    destroyWorkspaceRuntime: vi.fn(),
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    evictChatSdkInstance: vi.fn(),
    daemon: { getWorkspaceManager: () => mockWorkspaceManager } as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
    exposeKernel: false,
    platformModels: createStubPlatformModels(),
  };

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    await next();
  });

  return {
    app,
    registerWorkspace,
    updateWorkspaceStatus,
    find,
    getWorkspaceConfig,
    handleWorkspaceConfigChange,
  };
}

async function mountRoutes(app: Hono<AppVariables>) {
  const { workspacesRoutes } = await import("./index.ts");
  app.route("/", workspacesRoutes);
  return app;
}

describe("POST /create — requires_setup flag", () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolveCredentialsByProvider.mockReset();
    mockFetchLinkCredential.mockReset();
    mockWriteFile.mockReset().mockResolvedValue(undefined);
  });

  test("sets requires_setup: true when credentials cannot be resolved", {
    timeout: 15_000,
  }, async () => {
    const { app, registerWorkspace, updateWorkspaceStatus } = createTestApp();
    await mountRoutes(app);

    const { CredentialNotFoundError } = await import(
      "@atlas/core/mcp-registry/credential-resolver"
    );
    mockResolveCredentialsByProvider.mockRejectedValue(new CredentialNotFoundError("github"));

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithProvider("github") }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);

    // Env validation skipped because credentials are unresolved
    expect(registerWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ skipEnvValidation: true }),
    );

    // requires_setup should be set via updateWorkspaceStatus
    expect(updateWorkspaceStatus).toHaveBeenCalledWith(
      "ws-new-id",
      "inactive",
      expect.objectContaining({ metadata: expect.objectContaining({ requires_setup: true }) }),
    );
  });

  test("does not set requires_setup when all credentials resolve", async () => {
    const { app, registerWorkspace, updateWorkspaceStatus } = createTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([{ id: "cred-1", label: "My GitHub" }]);

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithProvider("github") }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);

    // Env validation NOT skipped when all credentials resolve
    expect(registerWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ skipEnvValidation: false }),
    );

    // updateWorkspaceStatus should NOT have been called with requires_setup
    expect(updateWorkspaceStatus).not.toHaveBeenCalled();
  });

  test("does not set requires_setup when no credentials needed", async () => {
    const { app, updateWorkspaceStatus } = createTestApp();
    await mountRoutes(app);

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithNoCredentials() }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);

    // No credentials to resolve for config setup, no requires_setup needed
    expect(updateWorkspaceStatus).not.toHaveBeenCalled();
  });

  test("partial resolution: resolves what it can, sets requires_setup for the rest", async () => {
    const { app, registerWorkspace, updateWorkspaceStatus } = createTestApp();
    await mountRoutes(app);

    const { CredentialNotFoundError } = await import(
      "@atlas/core/mcp-registry/credential-resolver"
    );

    // github resolves, slack does not
    mockResolveCredentialsByProvider
      .mockResolvedValueOnce([{ id: "cred-gh", label: "My GitHub" }])
      .mockRejectedValueOnce(new CredentialNotFoundError("slack"));

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithTwoProviders("github", "slack") }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);

    // Env validation skipped because slack is unresolved
    expect(registerWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ skipEnvValidation: true }),
    );

    // Partially resolved — still needs setup
    expect(updateWorkspaceStatus).toHaveBeenCalledWith(
      "ws-new-id",
      "inactive",
      expect.objectContaining({ metadata: expect.objectContaining({ requires_setup: true }) }),
    );

    // The resolved credential should be included in the response
    expect(body.resolvedCredentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "github", credentialId: "cred-gh" }),
      ]),
    );
  });
});

describe("POST /:workspaceId/setup/complete", () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolveCredentialsByProvider.mockReset();
    mockFetchLinkCredential.mockReset();
    mockWriteFile.mockReset().mockResolvedValue(undefined);
  });

  test("returns 200 and clears requires_setup when all credentials are connected", async () => {
    const { app, find, getWorkspaceConfig, updateWorkspaceStatus } = createTestApp();
    await mountRoutes(app);

    find.mockResolvedValue({
      id: "ws-test-id",
      name: "Test Workspace",
      status: "inactive",
      metadata: { requires_setup: true },
    });
    getWorkspaceConfig.mockResolvedValue({
      atlas: null,
      workspace: configWithConnectedCredentials(),
    });

    const response = await app.request("/ws-test-id/setup/complete", { method: "POST" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({ ok: true });

    expect(updateWorkspaceStatus).toHaveBeenCalledWith(
      "ws-test-id",
      "inactive",
      expect.objectContaining({ metadata: expect.objectContaining({ requires_setup: false }) }),
    );
  });

  test("returns 422 with missing providers when some credentials lack IDs", async () => {
    const { app, find, getWorkspaceConfig, updateWorkspaceStatus } = createTestApp();
    await mountRoutes(app);

    find.mockResolvedValue({
      id: "ws-test-id",
      name: "Test Workspace",
      status: "inactive",
      metadata: { requires_setup: true },
    });
    getWorkspaceConfig.mockResolvedValue({
      atlas: null,
      workspace: configWithMissingCredentials(),
    });

    const response = await app.request("/ws-test-id/setup/complete", { method: "POST" });

    expect(response.status).toBe(422);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({ error: "incomplete_setup", missingProviders: ["github"] });

    expect(updateWorkspaceStatus).not.toHaveBeenCalled();
  });

  test("returns 404 when workspace not found", async () => {
    const { app, find } = createTestApp();
    await mountRoutes(app);

    find.mockResolvedValue(null);

    const response = await app.request("/ws-nonexistent/setup/complete", { method: "POST" });

    expect(response.status).toBe(404);
  });
});
