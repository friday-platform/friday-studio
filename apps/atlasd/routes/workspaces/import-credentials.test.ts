import type { WorkspaceManager } from "@atlas/workspace";
import { parse } from "@std/yaml";
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";

const mockWriteWorkspaceFiles = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// Mock storeWorkspaceHistory to avoid Cortex dependencies
vi.mock("@atlas/storage", () => ({
  storeWorkspaceHistory: vi.fn().mockResolvedValue(undefined),
  FilesystemWorkspaceCreationAdapter: class {
    createWorkspaceDirectory() {
      return Promise.resolve("/tmp/test-workspace");
    }
    writeWorkspaceFiles = mockWriteWorkspaceFiles;
  },
}));

// Mock analytics
vi.mock("@atlas/analytics", () => ({
  createAnalyticsClient: () => ({ emit: vi.fn(), track: vi.fn(), flush: vi.fn() }),
  EventNames: { WORKSPACE_CREATED: "workspace.created" },
}));

// Mock getCurrentUser
vi.mock("../me/adapter.ts", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ ok: true, data: { id: "user-1" } }),
}));

// Mock resolveCredentialsByProvider and fetchLinkCredential to control Link responses
const { mockResolveCredentialsByProvider, mockFetchLinkCredential } = vi.hoisted(() => ({
  mockResolveCredentialsByProvider: vi.fn(),
  mockFetchLinkCredential: vi.fn(),
}));
vi.mock("@atlas/core/mcp-registry/credential-resolver", () => ({
  fetchLinkCredential: mockFetchLinkCredential,
  LinkCredentialNotFoundError: class extends Error {
    override name = "LinkCredentialNotFoundError";
    constructor(public readonly credentialId: string) {
      super(`Credential '${credentialId}' not found`);
    }
  },
  resolveCredentialsByProvider: mockResolveCredentialsByProvider,
  CredentialNotFoundError: class extends Error {
    override name = "CredentialNotFoundError";
    constructor(public readonly provider: string) {
      super(`No credentials found for provider '${provider}'`);
    }
  },
}));

// Mock getAtlasHome
vi.mock("@atlas/utils/paths.server", () => ({ getAtlasHome: () => "/tmp/atlas-home" }));

type JsonBody = Record<string, unknown>;

function createImportTestApp() {
  const mockRegisterWorkspace = vi
    .fn()
    .mockResolvedValue({
      workspace: {
        id: "ws-new",
        name: "Imported Workspace",
        path: "/tmp/test-workspace",
        status: "inactive",
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        metadata: {},
      },
      created: true,
    });

  const mockWorkspaceManager = {
    find: vi.fn().mockResolvedValue(null),
    getWorkspaceConfig: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    registerWorkspace: mockRegisterWorkspace,
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
    getWorkspaceRuntime: vi.fn(),
    destroyWorkspaceRuntime: vi.fn(),
    getLibraryStorage: vi.fn(),
    daemon: { getWorkspaceManager: () => mockWorkspaceManager } as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
    getAgentRegistry: vi.fn(),
  };

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    await next();
  });

  return { app, mockContext, mockRegisterWorkspace };
}

async function mountRoutes(app: Hono<AppVariables>) {
  const { workspacesRoutes } = await import("./index.ts");
  app.route("/", workspacesRoutes);
  return app;
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return { version: "1.0", workspace: { name: "Imported Workspace" }, ...overrides };
}

describe("POST /create — credential resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolveCredentialsByProvider.mockReset();
    mockFetchLinkCredential.mockReset();
    mockWriteWorkspaceFiles.mockReset();
  });

  test("imports config with no credentials unchanged", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: makeConfig() }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);
    // No resolveCredentialsByProvider calls needed
    expect(mockResolveCredentialsByProvider).not.toHaveBeenCalled();
  });

  test("imports config with only id-based refs unchanged", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_existing", key: "token" } },
            },
          },
        },
      },
    });

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);
    // No provider resolution needed — refs already have IDs
    expect(mockResolveCredentialsByProvider).not.toHaveBeenCalled();
  });

  test("resolves provider-based refs to id+provider refs", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred_user_gh", provider: "github", label: "My GitHub", type: "oauth" },
    ]);
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred_user_gh",
      provider: "github",
      type: "oauth",
      secret: { token: "ghp_xxx" },
    });

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "token" } },
            },
          },
        },
      },
    });

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);

    // Should include resolvedCredentials in the response
    expect(body.resolvedCredentials).toEqual([
      {
        path: "mcp:github:GITHUB_TOKEN",
        provider: "github",
        credentialId: "cred_user_gh",
        label: "My GitHub",
      },
    ]);

    // Should have called resolveCredentialsByProvider once for github
    expect(mockResolveCredentialsByProvider).toHaveBeenCalledWith("github");

    // Verify the written YAML contains the resolved credential ID
    expect(mockWriteWorkspaceFiles).toHaveBeenCalledOnce();
    const writtenYaml = mockWriteWorkspaceFiles.mock.calls[0]?.[1] as string;
    const writtenConfig = parse(writtenYaml) as Record<string, unknown>;
    const tools = writtenConfig.tools as Record<string, unknown>;
    const mcp = tools.mcp as Record<string, unknown>;
    const servers = mcp.servers as Record<string, unknown>;
    const github = servers.github as Record<string, unknown>;
    const env = github.env as Record<string, unknown>;
    expect(env.GITHUB_TOKEN).toMatchObject({
      from: "link",
      id: "cred_user_gh",
      provider: "github",
      key: "token",
    });
  });

  test("returns 400 listing ALL missing providers", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    const { CredentialNotFoundError } = await import(
      "@atlas/core/mcp-registry/credential-resolver"
    );
    mockResolveCredentialsByProvider.mockImplementation((provider: string) => {
      return Promise.reject(new CredentialNotFoundError(provider));
    });

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "token" } },
            },
            slack: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-slack"] },
              env: { SLACK_TOKEN: { from: "link", provider: "slack", key: "access_token" } },
            },
          },
        },
      },
    });

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({
      error: "missing_credentials",
      message: "Connect these integrations first",
    });
    // Both providers should be listed, not just the first
    expect((body.missingProviders as string[]).sort()).toEqual(["github", "slack"]);
  });

  test("picks first credential when multiple exist for a provider", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred_first", provider: "github", label: "Personal GitHub", type: "oauth" },
      { id: "cred_second", provider: "github", label: "Work GitHub", type: "oauth" },
    ]);
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred_first",
      provider: "github",
      type: "oauth",
      secret: { token: "ghp_xxx" },
    });

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "token" } },
            },
          },
        },
      },
    });

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);

    // Should pick the first credential
    expect(body.resolvedCredentials).toEqual([
      {
        path: "mcp:github:GITHUB_TOKEN",
        provider: "github",
        credentialId: "cred_first",
        label: "Personal GitHub",
      },
    ]);
  });

  test("resolves multiple providers in parallel", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockImplementation((provider: string) => {
      if (provider === "github") {
        return Promise.resolve([
          { id: "cred_gh", provider: "github", label: "My GitHub", type: "oauth" },
        ]);
      }
      if (provider === "slack") {
        return Promise.resolve([
          { id: "cred_sl", provider: "slack", label: "Work Slack", type: "oauth" },
        ]);
      }
      return Promise.resolve([]);
    });
    mockFetchLinkCredential.mockImplementation((credentialId: string) => {
      if (credentialId === "cred_gh") {
        return Promise.resolve({
          id: "cred_gh",
          provider: "github",
          type: "oauth",
          secret: { token: "ghp_xxx" },
        });
      }
      return Promise.resolve({
        id: "cred_sl",
        provider: "slack",
        type: "oauth",
        secret: { access_token: "xoxb-xxx" },
      });
    });

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "token" } },
            },
            slack: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-slack"] },
              env: { SLACK_TOKEN: { from: "link", provider: "slack", key: "access_token" } },
            },
          },
        },
      },
      agents: {
        researcher: {
          type: "atlas",
          agent: "research-agent",
          description: "Researcher",
          prompt: "Do research",
          env: { GITHUB_API: { from: "link", provider: "github", key: "token" } },
        },
      },
    });

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);

    // resolvedCredentials should include all three resolved refs
    const resolved = body.resolvedCredentials as Array<Record<string, string>>;
    expect(resolved).toHaveLength(3);
    expect(resolved).toContainEqual({
      path: "mcp:github:GITHUB_TOKEN",
      provider: "github",
      credentialId: "cred_gh",
      label: "My GitHub",
    });
    expect(resolved).toContainEqual({
      path: "mcp:slack:SLACK_TOKEN",
      provider: "slack",
      credentialId: "cred_sl",
      label: "Work Slack",
    });
    expect(resolved).toContainEqual({
      path: "agent:researcher:GITHUB_API",
      provider: "github",
      credentialId: "cred_gh",
      label: "My GitHub",
    });

    // Should only call resolveCredentialsByProvider twice (github + slack, deduplicated)
    expect(mockResolveCredentialsByProvider).toHaveBeenCalledTimes(2);
  });

  test("returns 400 with invalid_credential_keys when key is missing from secret", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred_gh", provider: "github", label: "My GitHub", type: "oauth" },
    ]);

    // Credential has "token" but config references "access_token"
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred_gh",
      provider: "github",
      type: "oauth",
      secret: { token: "ghp_xxx", refresh_token: "ghr_xxx" },
    });

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "access_token" } },
            },
          },
        },
      },
    });

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({
      error: "invalid_credential_keys",
      message: "Resolved credentials are missing expected keys",
    });
    expect(body.invalidKeys).toEqual([
      {
        path: "mcp:github:GITHUB_TOKEN",
        provider: "github",
        key: "access_token",
        availableKeys: ["token", "refresh_token"],
      },
    ]);
  });

  test("lists ALL invalid keys in a single error response", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockImplementation((provider: string) => {
      if (provider === "github") {
        return Promise.resolve([
          { id: "cred_gh", provider: "github", label: "My GitHub", type: "oauth" },
        ]);
      }
      if (provider === "slack") {
        return Promise.resolve([
          { id: "cred_sl", provider: "slack", label: "Work Slack", type: "oauth" },
        ]);
      }
      return Promise.resolve([]);
    });

    mockFetchLinkCredential.mockImplementation((credentialId: string) => {
      if (credentialId === "cred_gh") {
        return Promise.resolve({
          id: "cred_gh",
          provider: "github",
          type: "oauth",
          secret: { token: "ghp_xxx" },
        });
      }
      return Promise.resolve({
        id: "cred_sl",
        provider: "slack",
        type: "oauth",
        secret: { bot_token: "xoxb-xxx" },
      });
    });

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "access_token" } },
            },
            slack: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-slack"] },
              env: { SLACK_TOKEN: { from: "link", provider: "slack", key: "webhook_secret" } },
            },
          },
        },
      },
    });

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonBody;
    expect(body.error).toBe("invalid_credential_keys");
    const invalidKeys = body.invalidKeys as Array<Record<string, unknown>>;
    expect(invalidKeys).toHaveLength(2);
    expect(invalidKeys).toContainEqual({
      path: "mcp:github:GITHUB_TOKEN",
      provider: "github",
      key: "access_token",
      availableKeys: ["token"],
    });
    expect(invalidKeys).toContainEqual({
      path: "mcp:slack:SLACK_TOKEN",
      provider: "slack",
      key: "webhook_secret",
      availableKeys: ["bot_token"],
    });
  });

  test("valid keys pass through silently — no change to success response", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred_gh", provider: "github", label: "My GitHub", type: "oauth" },
    ]);

    mockFetchLinkCredential.mockResolvedValue({
      id: "cred_gh",
      provider: "github",
      type: "oauth",
      secret: { token: "ghp_xxx" },
    });

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "token" } },
            },
          },
        },
      },
    });

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);
    expect(body.resolvedCredentials).toEqual([
      {
        path: "mcp:github:GITHUB_TOKEN",
        provider: "github",
        credentialId: "cred_gh",
        label: "My GitHub",
      },
    ]);
  });

  test("deduplicates fetchLinkCredential calls by credential ID", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred_gh", provider: "github", label: "My GitHub", type: "oauth" },
    ]);

    mockFetchLinkCredential.mockResolvedValue({
      id: "cred_gh",
      provider: "github",
      type: "oauth",
      secret: { token: "ghp_xxx" },
    });

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "token" } },
            },
          },
        },
      },
      agents: {
        researcher: {
          type: "atlas",
          agent: "research-agent",
          description: "Researcher",
          prompt: "Do research",
          env: { GITHUB_API: { from: "link", provider: "github", key: "token" } },
        },
      },
    });

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });

    expect(response.status).toBe(201);
    // Only one fetchLinkCredential call despite two refs using the same credential
    expect(mockFetchLinkCredential).toHaveBeenCalledTimes(1);
    expect(mockFetchLinkCredential).toHaveBeenCalledWith("cred_gh", expect.anything());
  });

  test("returns 500 with credential_fetch_failed when fetchLinkCredential fails during key validation", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred_gh", provider: "github", label: "My GitHub", type: "oauth" },
    ]);

    mockFetchLinkCredential.mockRejectedValue(new Error("network timeout"));

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "token" } },
            },
          },
        },
      },
    });

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({
      error: "credential_fetch_failed",
      message: "Failed to fetch resolved credentials for key validation",
    });
    expect(body.details).toEqual([expect.stringContaining("network timeout")]);
  });

  test("partial missing: some providers found, some missing — returns 400 with missing list", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    const { CredentialNotFoundError } = await import(
      "@atlas/core/mcp-registry/credential-resolver"
    );
    mockResolveCredentialsByProvider.mockImplementation((provider: string) => {
      if (provider === "github") {
        return Promise.resolve([
          { id: "cred_gh", provider: "github", label: "My GitHub", type: "oauth" },
        ]);
      }
      return Promise.reject(new CredentialNotFoundError(provider));
    });

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "token" } },
            },
            slack: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-slack"] },
              env: { SLACK_TOKEN: { from: "link", provider: "slack", key: "access_token" } },
            },
          },
        },
      },
    });

    const response = await app.request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({
      error: "missing_credentials",
      message: "Connect these integrations first",
      missingProviders: ["slack"],
    });
  });
});
