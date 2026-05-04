import {
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
} from "@atlas/core/mcp-registry/credential-resolver";
import { createStubPlatformModels } from "@atlas/llm";
import type { WorkspaceManager } from "@atlas/workspace";
import { parse } from "@std/yaml";
import { Hono } from "hono";
import { assert, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";
import { workspacesRoutes } from "./index.ts";

vi.mock("@atlas/storage", () => ({ FilesystemWorkspaceCreationAdapter: vi.fn() }));

// Mock fetchLinkCredential to control Link responses — real error classes via importOriginal
const mockFetchLinkCredential = vi.hoisted(() => vi.fn());
vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>()),
  fetchLinkCredential: mockFetchLinkCredential,
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
    daemon: {} as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    evictChatSdkInstance: vi.fn(),
    exposeKernel: false,
    platformModels: createStubPlatformModels(),
  };

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    await next();
  });

  // Import and mount workspacesRoutes - need dynamic import since mocks must be set up first
  return { app, mockContext };
}

function mountRoutes(app: Hono<AppVariables>) {
  app.route("/", workspacesRoutes);
  return app;
}

describe("GET /:workspaceId/export", () => {
  beforeEach(() => {
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

  test.each([
    { label: "not-found", error: new LinkCredentialNotFoundError("cred_gone") },
    {
      label: "expired (no refresh)",
      error: new LinkCredentialExpiredError("cred_gone", "expired_no_refresh"),
    },
    {
      label: "expired (refresh failed)",
      error: new LinkCredentialExpiredError("cred_gone", "refresh_failed"),
    },
  ])("strips $label legacy credential refs and exports successfully", async ({ error }) => {
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
                env: { GITHUB_TOKEN: { from: "link", id: "cred_gone", key: "token" } },
              },
            },
          },
        },
      },
    };
    const { app } = createExportTestApp({ config });
    await mountRoutes(app);

    mockFetchLinkCredential.mockRejectedValue(error);

    const response = await app.request("/ws-test-id/export");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/yaml");

    const yaml = await response.text();
    const parsed = parse(yaml) as Record<string, unknown>;

    const ref = getExportedRef(parsed, "github", "GITHUB_TOKEN");
    expect(ref).toBeUndefined();

    const tools = parsed.tools as Record<string, unknown>;
    const mcp = (tools as Record<string, unknown>).mcp as Record<string, unknown>;
    const servers = mcp.servers as Record<string, unknown>;
    expect(servers.github).toBeDefined();

    expect(mockFetchLinkCredential).toHaveBeenCalledOnce();
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

  test("exports mixed refs: strips unresolvable legacy, resolves valid legacy, passes provider-based", async () => {
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
                    id: "cred_valid",
                    provider: "github",
                    key: "token",
                  },
                },
              },
              slack: {
                transport: { type: "stdio", command: "npx", args: ["-y", "server-slack"] },
                env: { SLACK_TOKEN: { from: "link", id: "cred_legacy_ok", key: "access_token" } },
              },
              sentry: {
                transport: { type: "http", url: "https://mcp.sentry.dev/mcp" },
                env: { SENTRY_TOKEN: { from: "link", id: "cred_deleted", key: "access_token" } },
              },
            },
          },
        },
      },
    };
    const { app } = createExportTestApp({ config });
    await mountRoutes(app);

    mockFetchLinkCredential.mockImplementation((credId: string) => {
      if (credId === "cred_legacy_ok") {
        return Promise.resolve({
          id: "cred_legacy_ok",
          provider: "slack",
          type: "oauth",
          secret: {},
        });
      }
      // cred_deleted is unresolvable
      return Promise.reject(new LinkCredentialNotFoundError(credId));
    });

    const response = await app.request("/ws-test-id/export");

    expect(response.status).toBe(200);
    const yaml = await response.text();
    const parsed = parse(yaml) as Record<string, unknown>;

    // Provider-based ref: id stripped, provider kept
    const githubRef = getExportedRef(parsed, "github", "GITHUB_TOKEN");
    assert(githubRef, "expected github GITHUB_TOKEN");
    expect(githubRef).toMatchObject({ from: "link", provider: "github", key: "token" });
    expect(githubRef).not.toHaveProperty("id");

    // Resolvable legacy ref: id stripped, provider resolved
    const slackRef = getExportedRef(parsed, "slack", "SLACK_TOKEN");
    assert(slackRef, "expected slack SLACK_TOKEN");
    expect(slackRef).toMatchObject({ from: "link", provider: "slack", key: "access_token" });
    expect(slackRef).not.toHaveProperty("id");

    // Unresolvable legacy ref: stripped entirely
    const sentryRef = getExportedRef(parsed, "sentry", "SENTRY_TOKEN");
    expect(sentryRef).toBeUndefined();
  });

  test("injects missing bundled agent credential refs on export", async () => {
    // Workspace has a bundled "slack" agent with no env block configured
    const config = {
      atlas: null,
      workspace: {
        version: "1.0",
        workspace: { id: "ws-test-id", name: "Test Workspace" },
        agents: {
          communicator: {
            type: "atlas",
            agent: "slack",
            description: "Slack communicator",
            prompt: "Send messages",
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
    const agentRef = getExportedAgentRef(parsed, "communicator", "SLACK_MCP_XOXP_TOKEN");

    assert(agentRef, "expected communicator SLACK_MCP_XOXP_TOKEN in export");
    expect(agentRef).toMatchObject({ from: "link", provider: "slack", key: "access_token" });
    expect(agentRef).not.toHaveProperty("id");
  });

  test("does not overwrite existing agent credential refs when injecting", async () => {
    // Workspace has a bundled "slack" agent with an existing credential ref
    const config = {
      atlas: null,
      workspace: {
        version: "1.0",
        workspace: { id: "ws-test-id", name: "Test Workspace" },
        agents: {
          communicator: {
            type: "atlas",
            agent: "slack",
            description: "Slack communicator",
            prompt: "Send messages",
            env: {
              SLACK_MCP_XOXP_TOKEN: {
                from: "link",
                id: "cred_existing",
                provider: "slack",
                key: "access_token",
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
    const agentRef = getExportedAgentRef(parsed, "communicator", "SLACK_MCP_XOXP_TOKEN");

    // Should keep the existing ref (with id stripped by export flow), not replace it
    assert(agentRef, "expected communicator SLACK_MCP_XOXP_TOKEN in export");
    expect(agentRef).toMatchObject({ from: "link", provider: "slack", key: "access_token" });
    expect(agentRef).not.toHaveProperty("id");
  });
});
