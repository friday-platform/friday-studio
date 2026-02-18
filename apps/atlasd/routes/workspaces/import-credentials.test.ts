import {
  CredentialNotFoundError,
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
} from "@atlas/core/mcp-registry/credential-resolver";
import type { WorkspaceManager } from "@atlas/workspace";
import { parse } from "@std/yaml";
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";
import { workspacesRoutes } from "./index.ts";

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

// Mock resolveCredentialsByProvider and fetchLinkCredential — real error classes via importOriginal
const { mockResolveCredentialsByProvider, mockFetchLinkCredential } = vi.hoisted(() => ({
  mockResolveCredentialsByProvider: vi.fn(),
  mockFetchLinkCredential: vi.fn(),
}));
vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>()),
  fetchLinkCredential: mockFetchLinkCredential,
  resolveCredentialsByProvider: mockResolveCredentialsByProvider,
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
    updateWorkspaceStatus: vi.fn().mockResolvedValue(undefined),
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

function mountRoutes(app: Hono<AppVariables>) {
  app.route("/", workspacesRoutes);
  return app;
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return { version: "1.0", workspace: { name: "Imported Workspace" }, ...overrides };
}

/** Extract a credential ref from the written YAML config. */
function getWrittenRef(serverName: string, envVar: string): Record<string, unknown> | undefined {
  const writtenYaml = mockWriteWorkspaceFiles.mock.calls[0]?.[1] as string;
  const config = parse(writtenYaml) as Record<string, unknown>;
  const tools = config.tools as Record<string, unknown> | undefined;
  const mcp = tools?.mcp as Record<string, unknown> | undefined;
  const servers = mcp?.servers as Record<string, unknown> | undefined;
  const server = servers?.[serverName] as Record<string, unknown> | undefined;
  const env = server?.env as Record<string, unknown> | undefined;
  const ref = env?.[envVar];
  return ref && typeof ref === "object" ? (ref as Record<string, unknown>) : undefined;
}

/** Extract a server definition from the written YAML config. */
function getWrittenServer(serverName: string): Record<string, unknown> | undefined {
  const writtenYaml = mockWriteWorkspaceFiles.mock.calls[0]?.[1] as string;
  const config = parse(writtenYaml) as Record<string, unknown>;
  const tools = config.tools as Record<string, unknown> | undefined;
  const mcp = tools?.mcp as Record<string, unknown> | undefined;
  const servers = mcp?.servers as Record<string, unknown> | undefined;
  return servers?.[serverName] as Record<string, unknown> | undefined;
}

/** Extract an agent env var from the written YAML config. */
function getWrittenAgentEnv(agentName: string): Record<string, unknown> | undefined {
  const writtenYaml = mockWriteWorkspaceFiles.mock.calls[0]?.[1] as string;
  const config = parse(writtenYaml) as Record<string, unknown>;
  const agents = config.agents as Record<string, unknown> | undefined;
  const agent = agents?.[agentName] as Record<string, unknown> | undefined;
  return agent?.env as Record<string, unknown> | undefined;
}

describe("POST /create — credential resolution", () => {
  beforeEach(() => {
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

  test("strips foreign id-only refs and imports workspace without them", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    // Credential ID belongs to another user — Link returns 404
    mockFetchLinkCredential.mockRejectedValue(new LinkCredentialNotFoundError("cred_foreign"));

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_foreign", key: "token" } },
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
    // Should report what was stripped
    expect(body.strippedCredentials).toEqual(["mcp:github:GITHUB_TOKEN"]);

    // The written config should NOT contain the foreign credential ref
    expect(mockWriteWorkspaceFiles).toHaveBeenCalledOnce();
    expect(getWrittenRef("github", "GITHUB_TOKEN")).toBeUndefined();
    expect(getWrittenServer("github")).toBeDefined();
  });

  test("strips foreign id-only refs from agent-level env vars", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockFetchLinkCredential.mockRejectedValue(new LinkCredentialNotFoundError("cred_foreign"));

    const config = makeConfig({
      agents: {
        summarizer: {
          type: "atlas",
          agent: "summarizer",
          description: "Summarizes content",
          prompt: "Summarize the input",
          env: { API_KEY: { from: "link", id: "cred_foreign", key: "api_key" } },
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
    expect(body.strippedCredentials).toEqual(["agent:summarizer:API_KEY"]);

    // The written config should strip the env var but preserve the agent
    expect(mockWriteWorkspaceFiles).toHaveBeenCalledOnce();
    const agentEnv = getWrittenAgentEnv("summarizer");
    expect(agentEnv).toBeDefined();
    expect(agentEnv?.API_KEY).toBeUndefined();
  });

  test("returns 400 with actionable message for expired id-only credentials", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockFetchLinkCredential.mockRejectedValue(
      new LinkCredentialExpiredError("cred_expired", "expired_no_refresh"),
    );

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_expired", key: "token" } },
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
    expect(body.error).toBe("credential_expired");
    expect(body.expiredCredentials).toEqual([
      {
        credentialId: "cred_expired",
        path: "mcp:github:GITHUB_TOKEN",
        status: "expired_no_refresh",
      },
    ]);
  });

  test("returns 400 for refresh-failed id-only credentials", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockFetchLinkCredential.mockRejectedValue(
      new LinkCredentialExpiredError("cred_stale", "refresh_failed"),
    );

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            slack: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-slack"] },
              env: { SLACK_TOKEN: { from: "link", id: "cred_stale", key: "access_token" } },
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
    expect(body.error).toBe("credential_expired");
    expect(body.expiredCredentials).toEqual([
      { credentialId: "cred_stale", path: "mcp:slack:SLACK_TOKEN", status: "refresh_failed" },
    ]);
  });

  test("returns 400 for expired when mixed with not-found refs — expired takes priority", async () => {
    const { app, mockRegisterWorkspace } = createImportTestApp();
    await mountRoutes(app);

    mockFetchLinkCredential.mockImplementation((credId: string) => {
      if (credId === "cred_expired") {
        return Promise.reject(new LinkCredentialExpiredError("cred_expired", "expired_no_refresh"));
      }
      if (credId === "cred_deleted") {
        return Promise.reject(new LinkCredentialNotFoundError("cred_deleted"));
      }
      throw new Error(`Unexpected credential ID: ${credId}`);
    });

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_expired", key: "token" } },
            },
            sentry: {
              transport: { type: "http", url: "https://mcp.sentry.dev/mcp" },
              env: { SENTRY_TOKEN: { from: "link", id: "cred_deleted", key: "access_token" } },
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
    expect(body.error).toBe("credential_expired");
    expect(body.expiredCredentials).toEqual([
      {
        credentialId: "cred_expired",
        path: "mcp:github:GITHUB_TOKEN",
        status: "expired_no_refresh",
      },
    ]);
    // Workspace should NOT be created when expired credentials exist
    expect(mockRegisterWorkspace).not.toHaveBeenCalled();
  });

  test("returns 400 with all expired credentials when multiple are expired", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockFetchLinkCredential.mockImplementation((credId: string) => {
      if (credId === "cred_expired_1") {
        return Promise.reject(
          new LinkCredentialExpiredError("cred_expired_1", "expired_no_refresh"),
        );
      }
      if (credId === "cred_expired_2") {
        return Promise.reject(new LinkCredentialExpiredError("cred_expired_2", "refresh_failed"));
      }
      throw new Error(`Unexpected credential ID: ${credId}`);
    });

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_expired_1", key: "token" } },
            },
            slack: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-slack"] },
              env: { SLACK_TOKEN: { from: "link", id: "cred_expired_2", key: "access_token" } },
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
    expect(body.error).toBe("credential_expired");
    const expired = body.expiredCredentials as Array<Record<string, string>>;
    expect(expired).toHaveLength(2);
    expect(expired).toEqual(
      expect.arrayContaining([
        {
          credentialId: "cred_expired_1",
          path: "mcp:github:GITHUB_TOKEN",
          status: "expired_no_refresh",
        },
        { credentialId: "cred_expired_2", path: "mcp:slack:SLACK_TOKEN", status: "refresh_failed" },
      ]),
    );
  });

  test("converts resolvable id-only refs to provider-only and re-resolves for importing user", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    // Phase 1: fetchLinkCredential during preprocessing finds the credential
    // (it belongs to the current user) and returns its provider
    mockFetchLinkCredential.mockImplementation((credId: string) => {
      if (credId === "cred_own") {
        return Promise.resolve({
          id: "cred_own",
          provider: "github",
          type: "oauth",
          secret: { token: "ghp_xxx" },
        });
      }
      // Phase 2: re-fetch during key validation (same credential, resolved via provider)
      if (credId === "cred_resolved") {
        return Promise.resolve({
          id: "cred_resolved",
          provider: "github",
          type: "oauth",
          secret: { token: "ghp_xxx" },
        });
      }
      throw new Error(`Unexpected credential ID: ${credId}`);
    });

    // Phase 2: resolveCredentialsByProvider resolves "github" to user's credential
    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred_resolved", provider: "github", label: "My GitHub", type: "oauth" },
    ]);

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_own", key: "token" } },
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
    // Should have resolved the provider-only ref to the user's credential
    expect(body.resolvedCredentials).toEqual([
      {
        path: "mcp:github:GITHUB_TOKEN",
        provider: "github",
        credentialId: "cred_resolved",
        label: "My GitHub",
      },
    ]);
    // No strippedCredentials since the ref was resolvable
    expect(body.strippedCredentials).toBeUndefined();
    // Preprocessing lookup only (key validation removed)
    expect(mockFetchLinkCredential).toHaveBeenCalledTimes(1);
    expect(mockFetchLinkCredential).toHaveBeenCalledWith("cred_own", expect.anything());
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
    expect(getWrittenRef("github", "GITHUB_TOKEN")).toMatchObject({
      from: "link",
      id: "cred_user_gh",
      provider: "github",
      key: "token",
    });
  });

  test("creates workspace with requires_setup when all providers missing", async () => {
    const { app, mockRegisterWorkspace } = createImportTestApp();
    await mountRoutes(app);

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

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);
    // Workspace should be created
    expect(mockRegisterWorkspace).toHaveBeenCalled();
    // requires_setup should be set in the returned workspace metadata
    const workspace = body.workspace as Record<string, unknown>;
    const metadata = workspace.metadata as Record<string, unknown>;
    expect(metadata.requires_setup).toBe(true);
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

  test("creates workspace even when credential key mismatches (no secret validation)", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred_gh", provider: "github", label: "My GitHub", type: "oauth" },
    ]);

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

    // Workspace is created; secret validation is skipped
    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);
    // fetchLinkCredential should NOT be called (secret validation removed)
    expect(mockFetchLinkCredential).not.toHaveBeenCalled();
  });

  test("creates workspace with resolved credentials even when keys mismatch", async () => {
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

    // Workspace is created; secret validation is skipped
    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);
    // Both providers resolved, so credentials should be included
    const resolved = body.resolvedCredentials as Array<Record<string, string>>;
    expect(resolved).toHaveLength(2);
    // fetchLinkCredential should NOT be called (secret validation removed)
    expect(mockFetchLinkCredential).not.toHaveBeenCalled();
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

  test("does not call fetchLinkCredential during create (secret validation removed)", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred_gh", provider: "github", label: "My GitHub", type: "oauth" },
    ]);

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
    // fetchLinkCredential is no longer called during create
    expect(mockFetchLinkCredential).not.toHaveBeenCalled();
  });

  test("creates workspace even if fetchLinkCredential would fail (no secret validation)", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred_gh", provider: "github", label: "My GitHub", type: "oauth" },
    ]);

    // fetchLinkCredential would fail, but it's no longer called during create
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

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);
    // fetchLinkCredential should NOT be called
    expect(mockFetchLinkCredential).not.toHaveBeenCalled();
  });

  test("returns 500 when fetchLinkCredential throws unexpected error during id-only preprocessing", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    mockFetchLinkCredential.mockRejectedValue(new Error("network timeout"));

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: { GITHUB_TOKEN: { from: "link", id: "cred_foreign", key: "token" } },
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
    expect(body.success).toBe(false);
    expect(body.error).toContain("network timeout");
  });

  test("replaces foreign id in refs with both id and provider", async () => {
    const { app } = createImportTestApp();
    await mountRoutes(app);

    // Ref has both id (foreign) and provider — should resolve via provider
    mockResolveCredentialsByProvider.mockResolvedValue([
      { id: "cred_mine", provider: "github", label: "My GitHub", type: "oauth" },
    ]);

    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            github: {
              transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
              env: {
                GITHUB_TOKEN: {
                  from: "link",
                  id: "cred_foreign",
                  provider: "github",
                  key: "token",
                },
              },
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

    // Foreign id should be replaced by user's credential
    expect(body.resolvedCredentials).toEqual([
      {
        path: "mcp:github:GITHUB_TOKEN",
        provider: "github",
        credentialId: "cred_mine",
        label: "My GitHub",
      },
    ]);

    // Written YAML should contain the user's credential ID, not the foreign one
    expect(mockWriteWorkspaceFiles).toHaveBeenCalledOnce();
    expect(getWrittenRef("github", "GITHUB_TOKEN")).toMatchObject({
      from: "link",
      id: "cred_mine",
      provider: "github",
      key: "token",
    });

    // fetchLinkCredential should NOT have been called for the foreign id —
    // the id-only preprocessing filter skips refs that already have a provider
    expect(mockFetchLinkCredential).not.toHaveBeenCalledWith("cred_foreign", expect.anything());
  });

  test("partial missing: creates workspace with requires_setup and resolves found providers", async () => {
    const { app, mockRegisterWorkspace } = createImportTestApp();
    await mountRoutes(app);

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

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(true);
    expect(mockRegisterWorkspace).toHaveBeenCalled();
    // requires_setup should be set because slack is unresolved
    const workspace = body.workspace as Record<string, unknown>;
    const metadata = workspace.metadata as Record<string, unknown>;
    expect(metadata.requires_setup).toBe(true);
    // github should still be resolved
    expect(body.resolvedCredentials).toEqual([
      {
        path: "mcp:github:GITHUB_TOKEN",
        provider: "github",
        credentialId: "cred_gh",
        label: "My GitHub",
      },
    ]);
  });
});
