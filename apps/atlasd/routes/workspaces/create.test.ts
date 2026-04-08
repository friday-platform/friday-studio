/**
 * Integration tests for POST /create (requires_setup flag) and
 * POST /:workspaceId/setup/complete endpoint.
 *
 * Tests the create endpoint sets requires_setup when credentials can't resolve,
 * and the setup/complete endpoint verifies all credentials before clearing the flag.
 */

import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";

// Mock storage (FilesystemWorkspaceCreationAdapter used in create)
vi.mock("@atlas/storage", () => ({
  storeWorkspaceHistory: vi.fn().mockResolvedValue(undefined),
  FilesystemWorkspaceCreationAdapter: class {
    createWorkspaceDirectory = vi.fn().mockResolvedValue("/tmp/test-ws");
    writeWorkspaceFiles = vi.fn().mockResolvedValue(undefined);
  },
}));

// Mock analytics
vi.mock("@atlas/analytics", () => ({
  createAnalyticsClient: () => ({ emit: vi.fn(), track: vi.fn(), flush: vi.fn() }),
  EventNames: { WORKSPACE_CREATED: "workspace.created" },
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

// Mock createLinkWireClient and createLinkUnwiredClient used by auto-wiring
const mockWireToWorkspace = vi.hoisted(() =>
  vi
    .fn<
      (
        credentialId: string,
        workspaceId: string,
        workspaceName: string,
        description?: string,
      ) => Promise<string | undefined>
    >()
    .mockResolvedValue(undefined),
);
const mockFindUnwired = vi.hoisted(() =>
  vi.fn<() => Promise<{ credentialId: string; appId: string } | null>>().mockResolvedValue(null),
);
vi.mock("../../src/services/slack-auto-wire.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/services/slack-auto-wire.ts")>();
  return {
    ...original,
    createLinkWireClient: () => mockWireToWorkspace,
    createLinkUnwiredClient: () => mockFindUnwired,
  };
});

// Mock writeFile used to update workspace config after auto-wiring
const mockWriteFile = vi.hoisted(() =>
  vi.fn<(path: string, data: string | Uint8Array) => Promise<void>>().mockResolvedValue(undefined),
);
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, writeFile: mockWriteFile };
});

// Mock applyMutation used by POST /add auto-wiring
const mockApplyMutation = vi.hoisted(() =>
  vi
    .fn<(path: string, fn: unknown, opts?: unknown) => Promise<{ ok: true }>>()
    .mockResolvedValue({ ok: true }),
);
vi.mock("@atlas/config/mutations", async (importOriginal) => {
  const original = await importOriginal<typeof import("@atlas/config/mutations")>();
  return { ...original, applyMutation: mockApplyMutation };
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

  const find = vi.fn();
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
    getLibraryStorage: vi.fn(),
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    evictChatSdkInstance: vi.fn(),
    getLedgerAdapter: vi.fn(),
    getActivityAdapter: vi.fn(),
    daemon: { getWorkspaceManager: () => mockWorkspaceManager } as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
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
    mockWireToWorkspace.mockReset().mockResolvedValue(undefined);
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockApplyMutation.mockReset().mockResolvedValue({ ok: true });
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
    mockWireToWorkspace.mockReset().mockResolvedValue(undefined);
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockApplyMutation.mockReset().mockResolvedValue({ ok: true });
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

describe("POST /create — Slack auto-wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolveCredentialsByProvider.mockReset();
    mockFetchLinkCredential.mockReset();
    mockFindUnwired
      .mockReset()
      .mockResolvedValue({ credentialId: "cred-slack-1", appId: "A123SLACK" });
    mockWireToWorkspace.mockReset().mockResolvedValue("A123SLACK");
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockApplyMutation.mockReset().mockResolvedValue({ ok: true });
  });

  test("auto-wires unwired slack credential and updates config", async () => {
    const { app } = createTestApp();
    await mountRoutes(app);

    // First call: for config credential resolution (no providers in config, resolves empty)
    // Subsequent call: for auto-wire (returns unwired credential)
    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred-slack-1", provider: "slack-app", label: "", type: "oauth" },
    ]);
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred-slack-1",
      provider: "slack-app",
      type: "oauth",
      secret: { externalId: "A123SLACK", access_token: "pending" },
    });

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithNoCredentials() }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);
    expect(body.slackWired).toEqual({ credentialId: "cred-slack-1", appId: "A123SLACK" });

    expect(mockWireToWorkspace).toHaveBeenCalledWith(
      "cred-slack-1",
      "ws-new-id",
      "Test Workspace",
      undefined,
    );
    expect(mockApplyMutation).toHaveBeenCalledWith("/tmp/test-ws", expect.any(Function));

    const call = mockApplyMutation.mock.calls[0];
    if (!call) throw new Error("applyMutation not called");
    const mutationFn = call[1] as (config: Record<string, unknown>) => {
      ok: boolean;
      value?: Record<string, unknown>;
    };
    const result = mutationFn({ signals: {} });
    expect(result.ok).toBe(true);
    expect(result.value?.signals).toEqual({
      slack: { description: "Slack messages", provider: "slack", config: { app_id: "A123SLACK" } },
    });
  });

  test("succeeds without slack when no unwired credential exists", async () => {
    const { app } = createTestApp();
    await mountRoutes(app);

    mockFindUnwired.mockResolvedValue(null);
    // All credentials are wired (non-empty label)
    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred-slack-1", provider: "slack-app", label: "ws-other", type: "oauth" },
    ]);

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithNoCredentials() }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);
    expect(body.slackWired).toBeUndefined();
    expect(mockWireToWorkspace).not.toHaveBeenCalled();
  });

  test("succeeds when no slack credentials exist at all", async () => {
    const { app } = createTestApp();
    await mountRoutes(app);

    mockFindUnwired.mockResolvedValue(null);
    const { CredentialNotFoundError } = await import(
      "@atlas/core/mcp-registry/credential-resolver"
    );
    mockResolveCredentialsByProvider.mockRejectedValue(new CredentialNotFoundError("slack-app"));

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithNoCredentials() }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);
    expect(body.slackWired).toBeUndefined();
  });

  test("succeeds even when wire endpoint fails", async () => {
    const { app } = createTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred-slack-1", provider: "slack-app", label: "", type: "oauth" },
    ]);
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred-slack-1",
      provider: "slack-app",
      type: "oauth",
      secret: { externalId: "A123SLACK", access_token: "pending" },
    });
    mockWireToWorkspace.mockRejectedValue(new Error("Link wire endpoint returned 500"));

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: configWithNoCredentials() }),
    });

    // Workspace creation still succeeds — auto-wire is best-effort
    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);
    expect(body.slackWired).toBeUndefined();
  });
});

describe("POST /add — Slack auto-wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolveCredentialsByProvider.mockReset();
    mockFetchLinkCredential.mockReset();
    mockFindUnwired
      .mockReset()
      .mockResolvedValue({ credentialId: "cred-slack-1", appId: "A123SLACK" });
    mockWireToWorkspace.mockReset().mockResolvedValue("A123SLACK");
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockApplyMutation.mockReset().mockResolvedValue({ ok: true });
  });

  test("auto-wires unwired slack credential on new workspace", async () => {
    const { app, handleWorkspaceConfigChange } = createTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred-slack-1", provider: "slack-app", label: "", type: "oauth" },
    ]);
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred-slack-1",
      provider: "slack-app",
      type: "oauth",
      secret: { externalId: "A123SLACK", access_token: "pending" },
    });

    const response = await app.request("/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/test-ws", name: "My Bot", description: "A test bot" }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.slackWired).toEqual({ credentialId: "cred-slack-1", appId: "A123SLACK" });

    expect(mockWireToWorkspace).toHaveBeenCalledWith(
      "cred-slack-1",
      "ws-new-id",
      "My Bot",
      "A test bot",
    );
    expect(mockApplyMutation).toHaveBeenCalledWith("/tmp/test-ws", expect.any(Function));
    // handleWorkspaceConfigChange is NOT called — file watcher detects the
    // workspace.yml change from applyMutation and triggers it. Explicit call
    // was removed to fix the double-fire race during Slack webhook verification.
    expect(handleWorkspaceConfigChange).not.toHaveBeenCalled();

    const call = mockApplyMutation.mock.calls[0];
    if (!call) throw new Error("applyMutation not called");
    const mutationFn = call[1] as (config: Record<string, unknown>) => {
      ok: boolean;
      value?: Record<string, unknown>;
    };
    const result = mutationFn({ signals: {} });
    expect(result.ok).toBe(true);
    expect(result.value?.signals).toEqual({
      slack: { description: "Slack messages", provider: "slack", config: { app_id: "A123SLACK" } },
    });
  });

  test("adds fresh slack signal alongside existing http signal", async () => {
    const { app } = createTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred-slack-1", provider: "slack-app", label: "", type: "oauth" },
    ]);
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred-slack-1",
      provider: "slack-app",
      type: "oauth",
      secret: { externalId: "A123SLACK", access_token: "pending" },
    });

    const response = await app.request("/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/test-ws", name: "My Bot" }),
    });

    expect(response.status).toBe(201);

    const call = mockApplyMutation.mock.calls[0];
    if (!call) throw new Error("applyMutation not called");
    const mutationFn = call[1] as (config: Record<string, unknown>) => {
      ok: boolean;
      value?: Record<string, unknown>;
    };
    const configWithHttpSlack = {
      signals: {
        "slack-bot-mention": {
          description: "Slack bot mentions",
          title: "Reads messages from Slack",
          provider: "http",
          config: { path: "/slack/events" },
        },
      },
    };
    const result = mutationFn(configWithHttpSlack);
    expect(result.ok).toBe(true);
    const signals = result.value?.signals as Record<string, Record<string, unknown>>;
    // HTTP signal left untouched
    expect(signals["slack-bot-mention"]).toEqual({
      description: "Slack bot mentions",
      title: "Reads messages from Slack",
      provider: "http",
      config: { path: "/slack/events" },
    });
    // Fresh slack signal created alongside
    expect(signals.slack).toEqual({
      description: "Slack messages",
      provider: "slack",
      config: { app_id: "A123SLACK" },
    });
  });

  test("updates stale app_id when slack provider signal already exists", async () => {
    const { app } = createTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred-slack-1", provider: "slack-app", label: "", type: "oauth" },
    ]);
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred-slack-1",
      provider: "slack-app",
      type: "oauth",
      secret: { externalId: "A123SLACK", access_token: "pending" },
    });

    const response = await app.request("/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/test-ws", name: "My Bot" }),
    });

    expect(response.status).toBe(201);

    const call = mockApplyMutation.mock.calls[0];
    if (!call) throw new Error("applyMutation not called");
    const mutationFn = call[1] as (config: Record<string, unknown>) => {
      ok: boolean;
      value?: Record<string, unknown>;
    };
    const configWithStaleSlack = {
      signals: {
        "slack-bot-mention": {
          description: "Slack bot mentions",
          provider: "slack",
          config: { app_id: "EXISTING_APP" },
        },
      },
    };
    const result = mutationFn(configWithStaleSlack);
    expect(result.ok).toBe(true);
    // Stale app_id gets updated to the new one
    const signals = result.value?.signals as Record<string, Record<string, unknown>>;
    expect(signals["slack-bot-mention"]).toMatchObject({
      description: "Slack bot mentions",
      provider: "slack",
      config: { app_id: "A123SLACK" },
    });
  });

  test("succeeds without slack when no unwired credential exists", async () => {
    const { app } = createTestApp();
    await mountRoutes(app);

    mockFindUnwired.mockResolvedValue(null);
    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred-slack-1", provider: "slack-app", label: "ws-other", type: "oauth" },
    ]);

    const response = await app.request("/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/test-ws", name: "My Bot" }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.slackWired).toBeUndefined();
    expect(mockWireToWorkspace).not.toHaveBeenCalled();
  });

  test("auto-wire failure does not block workspace registration", async () => {
    const { app } = createTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred-slack-1", provider: "slack-app", label: "", type: "oauth" },
    ]);
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred-slack-1",
      provider: "slack-app",
      type: "oauth",
      secret: { externalId: "A123SLACK", access_token: "pending" },
    });
    mockWireToWorkspace.mockRejectedValue(new Error("Link wire endpoint returned 500"));

    const response = await app.request("/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/test-ws", name: "My Bot" }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.slackWired).toBeUndefined();
  });
});
