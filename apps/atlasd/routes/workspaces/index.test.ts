/**
 * Input validation tests for workspace routes (POST /add, POST /add-batch,
 * POST /:workspaceId/update).
 *
 * Tests that zValidator rejects invalid payloads before handlers execute.
 */

import type { WorkspaceConfig } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";
import {
  extractJobIntegrations,
  formatJobName,
  injectBundledAgentRefs,
  workspacesRoutes,
} from "./index.ts";

vi.mock("../me/adapter.ts", () => ({ getCurrentUser: vi.fn().mockResolvedValue({ ok: false }) }));

function createTestApp() {
  const mockWorkspaceManager = {
    find: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    getWorkspaceConfig: vi.fn().mockResolvedValue(null),
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
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    evictChatSdkInstance: vi.fn(),
    daemon: {
      getWorkspaceManager: () => mockWorkspaceManager,
      runtimes: new Map(),
    } as unknown as AppContext["daemon"],
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
  app.route("/workspaces", workspacesRoutes);

  return { app };
}

function post(app: ReturnType<typeof createTestApp>["app"], path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /workspaces/add validation", () => {
  test("rejects missing path", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/add", { name: "test" });
    expect(res.status).toBe(400);
  });

  test("rejects empty path", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/add", { path: "" });
    expect(res.status).toBe(400);
  });

  test("rejects empty body", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/add", {});
    expect(res.status).toBe(400);
  });
});

describe("POST /workspaces/add-batch validation", () => {
  test("rejects missing paths", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/add-batch", {});
    expect(res.status).toBe(400);
  });

  test("rejects empty paths array", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/add-batch", { paths: [] });
    expect(res.status).toBe(400);
  });

  test("rejects non-array paths", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/add-batch", { paths: "not-an-array" });
    expect(res.status).toBe(400);
  });
});

describe("POST /workspaces/:workspaceId/update validation", () => {
  test("rejects missing config", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/ws-1/update", { backup: true });
    expect(res.status).toBe(400);
  });

  test("rejects empty body", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/ws-1/update", {});
    expect(res.status).toBe(400);
  });

  test("rejects config as non-object", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/ws-1/update", { config: "not-an-object" });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// POST /workspaces/:workspaceId/update — active-session guard
// =============================================================================

function makeSession(id: string, status: string) {
  return { id, jobName: "test", signalId: "sig", startedAt: new Date(), session: { id, status } };
}

function createTestAppWithRuntime(options: {
  sessions?: ReturnType<typeof makeSession>[];
  orchestratorActiveExecutions?: boolean;
  includeOrchestrator?: boolean;
}) {
  const {
    sessions = [],
    orchestratorActiveExecutions = false,
    includeOrchestrator = false,
  } = options;

  const mockRuntime: Record<string, unknown> = { getSessions: vi.fn().mockReturnValue(sessions) };
  if (includeOrchestrator) {
    mockRuntime.getOrchestrator = vi
      .fn()
      .mockReturnValue({
        hasActiveExecutions: vi.fn().mockReturnValue(orchestratorActiveExecutions),
      });
  }

  const mockWorkspace = {
    id: "ws-test",
    path: "/tmp/ws-test",
    status: "idle",
    metadata: {},
    name: "Test Workspace",
  };

  const mockWorkspaceManager = {
    find: vi.fn().mockResolvedValue(mockWorkspace),
    list: vi.fn().mockResolvedValue([]),
    getWorkspaceConfig: vi.fn().mockResolvedValue(null),
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
    getWorkspaceRuntime: vi.fn().mockReturnValue(mockRuntime),
    destroyWorkspaceRuntime: vi.fn(),
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    evictChatSdkInstance: vi.fn(),
    daemon: {
      getWorkspaceManager: () => mockWorkspaceManager,
      runtimes: new Map(),
    } as unknown as AppContext["daemon"],
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
  app.route("/workspaces", workspacesRoutes);

  return { app };
}

describe("POST /workspaces/:workspaceId/update — session guard", () => {
  test("returns 409 when active session exists and force is absent", async () => {
    const { app } = createTestAppWithRuntime({ sessions: [makeSession("sess-abc", "active")] });
    const res = await post(app, "/workspaces/ws-test/update", { config: {} });
    expect(res.status).toBe(409);
  });

  test("returns 409 when active session exists and force is false", async () => {
    const { app } = createTestAppWithRuntime({ sessions: [makeSession("sess-abc", "active")] });
    const res = await post(app, "/workspaces/ws-test/update", { config: {}, force: false });
    expect(res.status).toBe(409);
  });

  test("returns 409 when orchestrator.hasActiveExecutions() is true and force is absent", async () => {
    const { app } = createTestAppWithRuntime({
      sessions: [],
      includeOrchestrator: true,
      orchestratorActiveExecutions: true,
    });
    const res = await post(app, "/workspaces/ws-test/update", { config: {} });
    expect(res.status).toBe(409);
  });

  test("409 response body contains expected fields", async () => {
    const { app } = createTestAppWithRuntime({
      sessions: [makeSession("sess-xyz", "active"), makeSession("sess-def", "active")],
    });
    const res = await post(app, "/workspaces/ws-test/update", { config: {} });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      error: expect.stringContaining("force=true"),
      activeSessionIds: expect.arrayContaining(["sess-xyz", "sess-def"]),
      hasActiveExecutions: false,
    });
  });

  test("proceeds past guard when force=true even if active sessions exist", async () => {
    const { app } = createTestAppWithRuntime({ sessions: [makeSession("sess-abc", "active")] });
    const res = await post(app, "/workspaces/ws-test/update", { config: {}, force: true });
    expect(res.status).not.toBe(409);
  });

  test("proceeds normally when no active sessions and hasActiveExecutions=false", async () => {
    const { app } = createTestAppWithRuntime({
      sessions: [makeSession("sess-abc", "completed")],
      includeOrchestrator: true,
      orchestratorActiveExecutions: false,
    });
    const res = await post(app, "/workspaces/ws-test/update", { config: {} });
    expect(res.status).not.toBe(409);
  });

  test("proceeds normally when orchestrator is not available and no active sessions", async () => {
    const { app } = createTestAppWithRuntime({ sessions: [], includeOrchestrator: false });
    const res = await post(app, "/workspaces/ws-test/update", { config: {} });
    expect(res.status).not.toBe(409);
  });
});

// =============================================================================
// formatJobName
// =============================================================================

describe("formatJobName", () => {
  const cases = [
    {
      name: "uses title when present",
      key: "daily_summary",
      job: { title: "Daily Summary" },
      expected: "Daily Summary",
    },
    { name: "formats key without title", key: "daily_summary", job: {}, expected: "Daily summary" },
    { name: "handles single word key", key: "cleanup", job: {}, expected: "Cleanup" },
    {
      name: "ignores name field in favor of title",
      key: "x",
      job: { title: "My Title", name: "mcp-name" },
      expected: "My Title",
    },
    {
      name: "falls back to formatted key when no title",
      key: "send_weekly_report",
      job: { name: "mcp-name" },
      expected: "Send weekly report",
    },
  ] as const;

  test.each(cases)("$name", ({ key, job, expected }) => {
    expect(formatJobName(key, job)).toBe(expected);
  });
});

// =============================================================================
// extractJobIntegrations
// =============================================================================

describe("extractJobIntegrations", () => {
  function makeConfig(overrides: Record<string, unknown> = {}) {
    return { version: "1.0" as const, workspace: { id: "ws-1", name: "Test" }, ...overrides };
  }

  function makeFsmJob(tools: string[][]) {
    const states: Record<string, { entry: Array<{ type: string; tools: string[] }> }> = {};
    tools.forEach((t, i) => {
      states[`step_${i}`] = { entry: [{ type: "llm", tools: t }] };
    });
    return { fsm: { states } };
  }

  test("extracts providers from MCP servers referenced by FSM action tools", () => {
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            "github-server": { env: { TOKEN: { from: "link", provider: "github", key: "token" } } },
            "slack-server": { env: { TOKEN: { from: "link", provider: "slack", key: "token" } } },
          },
        },
      },
    });
    const job = makeFsmJob([["github-server", "slack-server"]]);
    expect(extractJobIntegrations(job, config)).toEqual(["github", "slack"]);
  });

  test("filters to only MCP servers used by the job's FSM actions", () => {
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            "github-server": { env: { TOKEN: { from: "link", provider: "github", key: "token" } } },
            "slack-server": { env: { TOKEN: { from: "link", provider: "slack", key: "token" } } },
          },
        },
      },
    });
    const job = makeFsmJob([["github-server"]]);
    expect(extractJobIntegrations(job, config)).toEqual(["github"]);
  });

  test("collects tools across multiple FSM states", () => {
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            "github-server": { env: { TOKEN: { from: "link", provider: "github", key: "token" } } },
            "slack-server": { env: { TOKEN: { from: "link", provider: "slack", key: "token" } } },
          },
        },
      },
    });
    const job = makeFsmJob([["github-server"], ["slack-server"]]);
    expect(extractJobIntegrations(job, config)).toEqual(["github", "slack"]);
  });

  test("deduplicates providers", () => {
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            server1: { env: { A: { from: "link", provider: "github", key: "a" } } },
            server2: { env: { B: { from: "link", provider: "github", key: "b" } } },
          },
        },
      },
    });
    const job = makeFsmJob([["server1", "server2"]]);
    expect(extractJobIntegrations(job, config)).toEqual(["github"]);
  });

  test("returns empty array when job has no FSM", () => {
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            "github-server": { env: { TOKEN: { from: "link", provider: "github", key: "token" } } },
          },
        },
      },
    });
    expect(extractJobIntegrations({}, config)).toEqual([]);
  });

  test("returns empty array when FSM actions have no tools", () => {
    const config = makeConfig();
    const job = { fsm: { states: { step_0: { entry: [{ type: "llm" }] } } } };
    expect(extractJobIntegrations(job, config)).toEqual([]);
  });

  test("extracts providers from bundled agent actions", () => {
    const config = makeConfig();
    const job = { fsm: { states: { step_0: { entry: [{ type: "agent", agentId: "slack" }] } } } };
    expect(extractJobIntegrations(job, config)).toEqual(["slack"]);
  });

  test("combines providers from LLM tools and bundled agents", () => {
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            "google-sheets": { env: { TOKEN: { from: "link", provider: "google", key: "token" } } },
          },
        },
      },
    });
    const job = {
      fsm: {
        states: {
          step_0: { entry: [{ type: "agent", agentId: "slack" }] },
          step_1: { entry: [{ type: "llm", tools: ["google-sheets"] }] },
        },
      },
    };
    expect(extractJobIntegrations(job, config)).toEqual(["google", "slack"]);
  });

  test("ignores unknown agent IDs", () => {
    const config = makeConfig();
    const job = {
      fsm: { states: { step_0: { entry: [{ type: "agent", agentId: "nonexistent" }] } } },
    };
    expect(extractJobIntegrations(job, config)).toEqual([]);
  });
});

// =============================================================================
// GET /workspaces/:workspaceId/jobs
// =============================================================================

describe("GET /workspaces/:workspaceId/jobs", () => {
  function createJobsTestApp(options: { config?: Record<string, unknown> | null }) {
    const { config = null } = options;

    const mockWorkspaceManager = {
      find: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      getWorkspaceConfig: vi.fn().mockResolvedValue(config),
      registerWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
    } as unknown as WorkspaceManager;

    const mockDaemon = { getWorkspaceManager: () => mockWorkspaceManager, runtimes: new Map() };

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
      daemon: mockDaemon as unknown as AppContext["daemon"],
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
    app.route("/workspaces", workspacesRoutes);

    return { app, mockWorkspaceManager };
  }

  test("returns enriched job data with title as name", async () => {
    const { app } = createJobsTestApp({
      config: {
        workspace: {
          version: "1.0",
          workspace: { id: "ws-1", name: "Test" },
          jobs: {
            daily_summary: {
              title: "Daily Summary",
              description: "Summarizes the day",
              execution: { agents: ["agent-1"], strategy: "sequential" },
            },
          },
        },
      },
    });

    const res = await app.request("/workspaces/ws-1/jobs");
    expect(res.status).toBe(200);

    const body = JSON.parse(await res.text());
    expect(body).toEqual([
      {
        id: "daily_summary",
        name: "Daily Summary",
        description: "Summarizes the day",
        integrations: [],
      },
    ]);
  });

  test("formats job key when no title", async () => {
    const { app } = createJobsTestApp({
      config: {
        workspace: {
          version: "1.0",
          workspace: { id: "ws-1", name: "Test" },
          jobs: {
            send_weekly_report: {
              description: "Weekly report",
              execution: { agents: ["agent-1"], strategy: "sequential" },
            },
          },
        },
      },
    });

    const res = await app.request("/workspaces/ws-1/jobs");
    const body = JSON.parse(await res.text()) as Record<string, unknown>[];
    expect(body[0]).toMatchObject({ id: "send_weekly_report", name: "Send weekly report" });
  });

  test("extracts integrations from MCP credentials per FSM job", async () => {
    const { app } = createJobsTestApp({
      config: {
        workspace: {
          version: "1.0",
          workspace: { id: "ws-1", name: "Test" },
          tools: {
            mcp: {
              servers: {
                "github-server": {
                  command: "npx",
                  env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "access_token" } },
                },
                "slack-server": {
                  command: "npx",
                  env: { SLACK_TOKEN: { from: "link", provider: "slack", key: "bot_token" } },
                },
              },
            },
          },
          jobs: {
            sync_issues: {
              title: "Sync Issues",
              fsm: { states: { step_0: { entry: [{ type: "llm", tools: ["github-server"] }] } } },
            },
            post_updates: {
              title: "Post Updates",
              fsm: { states: { step_0: { entry: [{ type: "llm", tools: ["slack-server"] }] } } },
            },
          },
        },
      },
    });

    const res = await app.request("/workspaces/ws-1/jobs");
    const body = JSON.parse(await res.text()) as Record<string, unknown>[];

    const syncJob = body.find((j: Record<string, unknown>) => j.id === "sync_issues");
    const postJob = body.find((j: Record<string, unknown>) => j.id === "post_updates");
    expect(syncJob?.integrations).toEqual(["github"]);
    expect(postJob?.integrations).toEqual(["slack"]);
  });

  test("returns 404 when workspace config not found", async () => {
    const { app } = createJobsTestApp({ config: null });

    const res = await app.request("/workspaces/ws-1/jobs");
    expect(res.status).toBe(404);

    const body = JSON.parse(await res.text());
    expect(body).toEqual({ error: "Workspace not found: ws-1" });
  });

  test("returns empty array when no jobs configured", async () => {
    const { app } = createJobsTestApp({
      config: { workspace: { version: "1.0", workspace: { id: "ws-1", name: "Test" } } },
    });

    const res = await app.request("/workspaces/ws-1/jobs");
    expect(res.status).toBe(200);

    const body = JSON.parse(await res.text());
    expect(body).toEqual([]);
  });
});

// =============================================================================
// Pending revision endpoints
// =============================================================================

describe("GET /workspaces/:workspaceId/pending-revision", () => {
  test("returns null when no pending revision", async () => {
    const { app } = createTestApp();
    const res = await app.request("/workspaces/ws-1/pending-revision");
    // Workspace not found (mock returns null)
    expect(res.status).toBe(404);
  });
});

describe("POST /workspaces/:workspaceId/pending-revision/approve", () => {
  test("returns 404 when workspace not found", async () => {
    const { app } = createTestApp();
    const res = await app.request("/workspaces/ws-1/pending-revision/approve", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("POST /workspaces/:workspaceId/pending-revision/reject", () => {
  test("returns 404 when workspace not found", async () => {
    const { app } = createTestApp();
    const res = await app.request("/workspaces/ws-1/pending-revision/reject", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// injectBundledAgentRefs
// =============================================================================

describe("injectBundledAgentRefs", () => {
  function makeConfig(agents?: WorkspaceConfig["agents"]): WorkspaceConfig {
    return { version: "1.0" as const, workspace: { id: "ws-1", name: "Test" }, agents };
  }

  test("returns config unchanged when agents is undefined", () => {
    const config = makeConfig(undefined);
    const result = injectBundledAgentRefs(config);
    expect(result).toBe(config);
  });

  test("skips non-atlas agent types", () => {
    const config = makeConfig({
      "my-llm": {
        type: "llm",
        description: "Custom LLM agent",
        config: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          prompt: "Do things",
          temperature: 0.3,
        },
      },
    });
    const result = injectBundledAgentRefs(config);
    expect(result).toBe(config);
  });

  test("skips atlas agent with unknown agent id", () => {
    const config = makeConfig({
      "my-agent": {
        type: "atlas",
        agent: "nonexistent-agent-id",
        description: "Unknown agent",
        prompt: "Do things",
      },
    });
    const result = injectBundledAgentRefs(config);
    expect(result).toBe(config);
  });

  test("injects missing link credential refs for bundled atlas agent", () => {
    const config = makeConfig({
      communicator: {
        type: "atlas",
        agent: "slack",
        description: "Slack communicator",
        prompt: "Talk on Slack",
      },
    });
    const result = injectBundledAgentRefs(config);

    expect(result).not.toBe(config);
    const agent = result.agents?.communicator;
    if (!agent || agent.type !== "atlas") throw new Error("Expected atlas agent");
    expect(agent.env).toMatchObject({
      SLACK_MCP_XOXP_TOKEN: { from: "link", provider: "slack", key: "access_token" },
    });
  });

  test("does not overwrite existing env refs", () => {
    const existingRef = { from: "link" as const, provider: "slack", key: "custom_token" };
    const config = makeConfig({
      communicator: {
        type: "atlas",
        agent: "slack",
        description: "Slack communicator",
        prompt: "Talk on Slack",
        env: { SLACK_MCP_XOXP_TOKEN: existingRef },
      },
    });
    const result = injectBundledAgentRefs(config);

    // No injection needed — all refs present — returns same object
    expect(result).toBe(config);
  });

  test("returns config unchanged when all refs already present", () => {
    const config = makeConfig({
      communicator: {
        type: "atlas",
        agent: "slack",
        description: "Slack communicator",
        prompt: "Talk on Slack",
        env: { SLACK_MCP_XOXP_TOKEN: { from: "link", provider: "slack", key: "access_token" } },
      },
    });
    const result = injectBundledAgentRefs(config);
    expect(result).toBe(config);
  });
});
