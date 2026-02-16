import type { WorkspaceManager } from "@atlas/workspace";
import { parse } from "@std/yaml";
import { Hono } from "hono";
import { assert, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";

// Mock storeWorkspaceHistory to avoid Cortex dependencies
vi.mock("@atlas/storage", () => ({
  storeWorkspaceHistory: vi.fn().mockResolvedValue(undefined),
  FilesystemWorkspaceCreationAdapter: vi.fn(),
}));

// Mock analytics
vi.mock("@atlas/analytics", () => ({
  createAnalyticsClient: () => ({ track: vi.fn(), flush: vi.fn() }),
  EventNames: {},
}));

// Mock fetchLinkCredential to control Link responses
const mockFetchLinkCredential = vi.hoisted(() => vi.fn());
vi.mock("@atlas/core/mcp-registry/credential-resolver", () => ({
  fetchLinkCredential: mockFetchLinkCredential,
  LinkCredentialNotFoundError: class extends Error {
    override name = "LinkCredentialNotFoundError";
    constructor(public readonly credentialId: string) {
      super(`Credential '${credentialId}' not found`);
    }
  },
}));

// Mock getCurrentUser
vi.mock("../me/adapter.ts", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: "user-1", email: "test@test.com" }),
}));

type WorkspaceConfig = Record<string, unknown>;

/** Extract a credential ref from parsed YAML export output. */
function getExportedRef(
  parsed: Record<string, unknown>,
  serverName: string,
  envVar: string,
): Record<string, unknown> | undefined {
  const tools = parsed.tools;
  if (!tools || typeof tools !== "object") return undefined;
  const mcp = (tools as Record<string, unknown>).mcp;
  if (!mcp || typeof mcp !== "object") return undefined;
  const servers = (mcp as Record<string, unknown>).servers;
  if (!servers || typeof servers !== "object") return undefined;
  const server = (servers as Record<string, unknown>)[serverName];
  if (!server || typeof server !== "object") return undefined;
  const env = (server as Record<string, unknown>).env;
  if (!env || typeof env !== "object") return undefined;
  const ref = (env as Record<string, unknown>)[envVar];
  if (!ref || typeof ref !== "object") return undefined;
  return ref as Record<string, unknown>;
}

/** Extract an agent credential ref from parsed YAML export output. */
function getExportedAgentRef(
  parsed: Record<string, unknown>,
  agentName: string,
  envVar: string,
): Record<string, unknown> | undefined {
  const agents = parsed.agents;
  if (!agents || typeof agents !== "object") return undefined;
  const agent = (agents as Record<string, unknown>)[agentName];
  if (!agent || typeof agent !== "object") return undefined;
  const env = (agent as Record<string, unknown>).env;
  if (!env || typeof env !== "object") return undefined;
  const ref = (env as Record<string, unknown>)[envVar];
  if (!ref || typeof ref !== "object") return undefined;
  return ref as Record<string, unknown>;
}

function createExportTestApp(options: {
  workspace?: Record<string, unknown> | null;
  config?: { atlas: null; workspace: WorkspaceConfig } | null;
}) {
  const {
    workspace = {
      id: "ws-test-id",
      name: "Test Workspace",
      path: "/tmp/test-workspace",
      configPath: "/tmp/test-workspace/workspace.yml",
      status: "inactive",
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      metadata: {},
    },
    config = null,
  } = options;

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
    getWorkspaceRuntime: vi.fn(),
    destroyWorkspaceRuntime: vi.fn(),
    getLibraryStorage: vi.fn(),
    daemon: {} as AppContext["daemon"],
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

  // Import and mount workspacesRoutes - need dynamic import since mocks must be set up first
  return { app, mockContext };
}

async function mountRoutes(app: Hono<AppVariables>) {
  const { workspacesRoutes } = await import("./index.ts");
  app.route("/", workspacesRoutes);
  return app;
}

describe("GET /:workspaceId/export", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetchLinkCredential.mockReset();
  });

  test("exports config with no credentials unchanged", async () => {
    const config = {
      atlas: null,
      workspace: { version: "1.0", workspace: { id: "ws-test-id", name: "Test Workspace" } },
    };
    const { app } = createExportTestApp({ config });
    await mountRoutes(app);

    const response = await app.request("/ws-test-id/export");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/yaml");

    const yaml = await response.text();
    const parsed = parse(yaml) as WorkspaceConfig;
    // workspace.id should be stripped
    expect(parsed.workspace).not.toHaveProperty("id");
    expect(parsed.workspace).toMatchObject({ name: "Test Workspace" });
  });

  test("strips id from refs that already have provider", async () => {
    const config = {
      atlas: null,
      workspace: {
        version: "1.0",
        workspace: { id: "ws-test-id", name: "Test Workspace" },
        tools: {
          mcp: {
            servers: {
              github: {
                transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
                env: {
                  GITHUB_TOKEN: {
                    from: "link",
                    id: "cred_abc123",
                    provider: "github",
                    key: "token",
                  },
                },
              },
            },
          },
        },
      },
    };
    const { app } = createExportTestApp({ config });
    await mountRoutes(app);

    const response = await app.request("/ws-test-id/export");

    expect(response.status).toBe(200);
    const yaml = await response.text();
    const parsed = parse(yaml) as Record<string, unknown>;
    const token = getExportedRef(parsed, "github", "GITHUB_TOKEN");

    expect(token).toMatchObject({ from: "link", provider: "github", key: "token" });
    expect(token).not.toHaveProperty("id");

    expect(mockFetchLinkCredential).not.toHaveBeenCalled();
  });

  test("resolves legacy id-only refs via Link fallback", async () => {
    const config = {
      atlas: null,
      workspace: {
        version: "1.0",
        workspace: { id: "ws-test-id", name: "Test Workspace" },
        tools: {
          mcp: {
            servers: {
              github: {
                transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
                env: { GITHUB_TOKEN: { from: "link", id: "cred_abc123", key: "token" } },
              },
            },
          },
        },
      },
    };
    const { app } = createExportTestApp({ config });
    await mountRoutes(app);

    // Mock Link to return credential with provider
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred_abc123",
      provider: "github",
      type: "oauth",
      secret: {},
    });

    const response = await app.request("/ws-test-id/export");

    expect(response.status).toBe(200);
    const yaml = await response.text();
    const parsed = parse(yaml) as Record<string, unknown>;
    const token = getExportedRef(parsed, "github", "GITHUB_TOKEN");

    expect(token).toMatchObject({ from: "link", provider: "github", key: "token" });
    expect(token).not.toHaveProperty("id");

    expect(mockFetchLinkCredential).toHaveBeenCalledOnce();
  });

  test("returns 422 when legacy credential cannot be resolved from Link", async () => {
    const config = {
      atlas: null,
      workspace: {
        version: "1.0",
        workspace: { id: "ws-test-id", name: "Test Workspace" },
        tools: {
          mcp: {
            servers: {
              github: {
                transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
                env: { GITHUB_TOKEN: { from: "link", id: "cred_deleted", key: "token" } },
              },
            },
          },
        },
      },
    };
    const { app } = createExportTestApp({ config });
    await mountRoutes(app);

    // Mock Link to throw not found
    const { LinkCredentialNotFoundError } = await import(
      "@atlas/core/mcp-registry/credential-resolver"
    );
    mockFetchLinkCredential.mockRejectedValue(new LinkCredentialNotFoundError("cred_deleted"));

    const response = await app.request("/ws-test-id/export");

    expect(response.status).toBe(422);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "unresolvable_credentials",
      message: "Cannot resolve credentials for export",
    });
    expect(body.unresolvedPaths).toEqual(["mcp:github:GITHUB_TOKEN"]);
  });

  test("returns 500 when legacy ref fetch fails with unexpected error", async () => {
    const config = {
      atlas: null,
      workspace: {
        version: "1.0",
        workspace: { id: "ws-test-id", name: "Test Workspace" },
        tools: {
          mcp: {
            servers: {
              github: {
                transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
                env: { GITHUB_TOKEN: { from: "link", id: "cred_abc123", key: "token" } },
              },
            },
          },
        },
      },
    };
    const { app } = createExportTestApp({ config });
    await mountRoutes(app);

    mockFetchLinkCredential.mockRejectedValue(new Error("network timeout"));

    const response = await app.request("/ws-test-id/export");

    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toContain("Failed to export workspace");
    expect(body.error).toContain("network timeout");
  });

  test("exports mixed refs: provider-based pass through, legacy resolved via Link", async () => {
    const config = {
      atlas: null,
      workspace: {
        version: "1.0",
        workspace: { id: "ws-test-id", name: "Test Workspace" },
        tools: {
          mcp: {
            servers: {
              github: {
                transport: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
                env: {
                  GITHUB_TOKEN: {
                    from: "link",
                    id: "cred_abc123",
                    provider: "github",
                    key: "token",
                  },
                },
              },
              slack: {
                transport: { type: "stdio", command: "npx", args: ["-y", "server-slack"] },
                env: { SLACK_TOKEN: { from: "link", id: "cred_legacy", key: "access_token" } },
              },
            },
          },
        },
      },
    };
    const { app } = createExportTestApp({ config });
    await mountRoutes(app);

    // Only the legacy ref needs Link lookup
    mockFetchLinkCredential.mockResolvedValue({
      id: "cred_legacy",
      provider: "slack",
      type: "oauth",
      secret: {},
    });

    const response = await app.request("/ws-test-id/export");

    expect(response.status).toBe(200);
    const yaml = await response.text();
    const parsed = parse(yaml) as Record<string, unknown>;

    const githubToken = getExportedRef(parsed, "github", "GITHUB_TOKEN");
    assert(githubToken, "expected github GITHUB_TOKEN in export");
    expect(githubToken).toMatchObject({ from: "link", provider: "github", key: "token" });
    expect(githubToken).not.toHaveProperty("id");

    const slackToken = getExportedRef(parsed, "slack", "SLACK_TOKEN");
    assert(slackToken, "expected slack SLACK_TOKEN in export");
    expect(slackToken).toMatchObject({ from: "link", provider: "slack", key: "access_token" });
    expect(slackToken).not.toHaveProperty("id");

    expect(mockFetchLinkCredential).toHaveBeenCalledOnce();
  });

  test("strips id from agent-level credential refs", async () => {
    const config = {
      atlas: null,
      workspace: {
        version: "1.0",
        workspace: { id: "ws-test-id", name: "Test Workspace" },
        agents: {
          researcher: {
            type: "atlas",
            agent: "research-agent",
            description: "Researcher",
            prompt: "Do research",
            env: {
              GITHUB_TOKEN: { from: "link", id: "cred_agent_gh", provider: "github", key: "token" },
            },
          },
        },
      },
    };
    const { app } = createExportTestApp({ config });
    await mountRoutes(app);

    const response = await app.request("/ws-test-id/export");

    expect(response.status).toBe(200);
    const yaml = await response.text();
    const parsed = parse(yaml) as Record<string, unknown>;
    const agentRef = getExportedAgentRef(parsed, "researcher", "GITHUB_TOKEN");

    assert(agentRef, "expected researcher GITHUB_TOKEN in export");
    expect(agentRef).toMatchObject({ from: "link", provider: "github", key: "token" });
    expect(agentRef).not.toHaveProperty("id");

    expect(mockFetchLinkCredential).not.toHaveBeenCalled();
  });
});
