/**
 * Integration tests for POST /create credential-resolution behavior.
 *
 * `requires_setup` is no longer stored on workspace metadata — it's live-
 * derived per request from parsed config + env + Link state via
 * `resolveWorkspaceSetupRequirements`. These tests assert the create endpoint
 * still surfaces unresolved credential paths in the response so the importer
 * can route the user into Workspace Setup, but does NOT write a stale
 * `requires_setup` flag on metadata.
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

// Bootstrap-spawn lives in its own file with its own targeted tests; the
// /create tests only care about the surrounding response shape, so stub the
// helper to a no-op result and let the call-sites continue.
const mockSpawnBootstrap = vi.hoisted(() =>
  vi
    .fn<
      () => Promise<{
        requires_setup: boolean;
        bootstrap_session_id?: string;
        setup_requirements: never[];
      }>
    >()
    .mockResolvedValue({ requires_setup: false, setup_requirements: [] }),
);
vi.mock("./setup-spawn.ts", () => ({ spawnBootstrapSessionIfNeeded: mockSpawnBootstrap }));

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
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: () => mockWorkspaceManager,
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    daemon: { getWorkspaceManager: () => mockWorkspaceManager } as AppContext["daemon"],
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

describe("POST /create — credential resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolveCredentialsByProvider.mockReset();
    mockFetchLinkCredential.mockReset();
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockSpawnBootstrap.mockReset();
    mockSpawnBootstrap.mockResolvedValue({ requires_setup: false, setup_requirements: [] });
  });

  test("returns unresolved credential paths when credentials cannot be resolved", {
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

    expect(registerWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ skipEnvValidation: true }),
    );

    // No stale `requires_setup` flag is ever written — it's live-derived now.
    expect(updateWorkspaceStatus).not.toHaveBeenCalled();

    expect(body.unresolvedCredentials).toEqual(expect.arrayContaining(["mcp:myserver:TOKEN"]));
  });

  test("skips env validation toggle off when all credentials resolve", async () => {
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

    expect(registerWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ skipEnvValidation: false }),
    );

    expect(updateWorkspaceStatus).not.toHaveBeenCalled();
  });

  test("emits no extra metadata writes when no credentials are needed", async () => {
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

    expect(updateWorkspaceStatus).not.toHaveBeenCalled();
  });

  test("partial resolution: resolved credentials reported, unresolved paths surfaced", async () => {
    const { app, registerWorkspace, updateWorkspaceStatus } = createTestApp();
    await mountRoutes(app);

    const { CredentialNotFoundError } = await import(
      "@atlas/core/mcp-registry/credential-resolver"
    );

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

    expect(registerWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ skipEnvValidation: true }),
    );

    expect(updateWorkspaceStatus).not.toHaveBeenCalled();

    expect(body.resolvedCredentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "github", credentialId: "cred-gh" }),
      ]),
    );
    expect(body.unresolvedCredentials).toEqual(expect.arrayContaining(["mcp:serverB:TOKEN_B"]));
  });
});

describe("POST /create — bootstrap setup spawn (T11)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolveCredentialsByProvider.mockReset();
    mockFetchLinkCredential.mockReset();
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockSpawnBootstrap.mockReset();
  });

  test("requires_setup === true → response carries bootstrapSessionId", async () => {
    mockSpawnBootstrap.mockResolvedValue({
      requires_setup: true,
      bootstrap_session_id: "bootstrap-abc",
      setup_requirements: [],
    });
    const { app } = createTestApp();
    await mountRoutes(app);

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithNoCredentials() }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);
    expect(body.bootstrapSessionId).toBe("bootstrap-abc");
    expect(mockSpawnBootstrap).toHaveBeenCalledTimes(1);
  });

  test("requires_setup === false → response omits bootstrapSessionId", async () => {
    mockSpawnBootstrap.mockResolvedValue({ requires_setup: false, setup_requirements: [] });
    const { app } = createTestApp();
    await mountRoutes(app);

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithNoCredentials() }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);
    expect(body.bootstrapSessionId).toBeUndefined();
  });

  test("StaleCredentialIdAtImportError → 400 with stale credential details", async () => {
    const { StaleCredentialIdAtImportError } = await import("@atlas/workspace");
    mockSpawnBootstrap.mockRejectedValue(
      new StaleCredentialIdAtImportError({
        credentialId: "cred_stale",
        provider: "gmail",
        path: "mcp_servers.gmail.credentials",
      }),
    );
    const { app } = createTestApp();
    await mountRoutes(app);

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithNoCredentials() }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonBody;
    expect(body.error).toBe("stale_credential_id_at_import");
    expect(body.credentialId).toBe("cred_stale");
    expect(body.provider).toBe("gmail");
  });
});
