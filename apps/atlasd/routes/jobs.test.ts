import type { MergedConfig, WorkspaceConfig } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../src/factory.ts";
import { jobsRoutes } from "./jobs.ts";

function createTestConfig(overrides: Record<string, unknown> = {}): WorkspaceConfig {
  return {
    version: "1.0",
    workspace: { id: "test-workspace", name: "Test Workspace" },
    ...overrides,
  } as WorkspaceConfig;
}

function createMergedConfig(workspaceConfig: WorkspaceConfig): MergedConfig {
  return { atlas: null, workspace: workspaceConfig };
}

function createJobsTestApp(options: { config?: MergedConfig | null }) {
  const { config = null } = options;

  const mockWorkspaceManager = {
    find: vi.fn(),
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
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    evictChatSdkInstance: vi.fn(),
    daemon: {} as AppContext["daemon"],
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
  app.route("/", jobsRoutes);

  return { app, mockWorkspaceManager };
}

describe("GET /jobs/:jobId/:workspaceId", () => {
  test("returns job detail with resolved signals and agents", async () => {
    const config = createTestConfig({
      jobs: {
        daily_summary: {
          title: "Daily Summary",
          description: "Summarizes daily activity",
          triggers: [{ signal: "cron.daily" }],
          execution: { strategy: "sequential", agents: ["summarizer"] },
        },
      },
      signals: {
        "cron.daily": {
          description: "Fires every day at 9 AM",
          provider: "schedule",
          config: { schedule: "0 9 * * *", timezone: "UTC" },
        },
      },
      agents: {
        summarizer: {
          type: "llm",
          description: "Summarizes activity",
          config: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            prompt: "Summarize",
            tools: [],
          },
        },
      },
    });
    const { app } = createJobsTestApp({ config: createMergedConfig(config) });

    const res = await app.request("/daily_summary/ws-123");
    expect(res.status).toBe(200);

    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: "daily_summary",
      name: "Daily Summary",
      description: "Summarizes daily activity",
      integrations: [],
    });

    // Signals resolved from config
    expect(body.signals).toEqual({
      "cron.daily": {
        description: "Fires every day at 9 AM",
        provider: "schedule",
        config: { schedule: "0 9 * * *", timezone: "UTC" },
      },
    });

    // Agents resolved with full details
    expect(body.agents).toEqual([
      {
        id: "summarizer",
        type: "llm",
        description: "Summarizes activity",
        prompt: "Summarize",
        model: "claude-sonnet-4-6",
        tools: [],
        integrations: [],
      },
    ]);

    // No triggers field
    expect(body).not.toHaveProperty("triggers");
  });

  const nameCases = [
    {
      name: "uses title when present",
      jobKey: "my_job",
      jobSpec: { title: "My Custom Title", execution: { agents: ["a"] } },
      expected: "My Custom Title",
    },
    {
      name: "formats key when no title (underscores/hyphens to spaces, sentence case)",
      jobKey: "send_weekly_report",
      jobSpec: { execution: { agents: ["a"] } },
      expected: "Send weekly report",
    },
    {
      name: "formats hyphenated key to spaces",
      jobKey: "Capture-and-log-friday-learning-ideas",
      jobSpec: { execution: { agents: ["a"] } },
      expected: "Capture and log friday learning ideas",
    },
    {
      name: "falls back to raw key",
      jobKey: "x",
      jobSpec: { execution: { agents: ["a"] } },
      expected: "X",
    },
  ] as const;

  test.each(nameCases)("name formatting: $name", async ({ jobKey, jobSpec, expected }) => {
    const config = createTestConfig({
      jobs: { [jobKey]: jobSpec },
      agents: { a: { type: "llm", config: { provider: "test", model: "test", prompt: "test" } } },
    });
    const { app } = createJobsTestApp({ config: createMergedConfig(config) });

    const res = await app.request(`/${jobKey}/ws-123`);
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(body.name).toBe(expected);
  });

  test("returns integrations from credential refs", async () => {
    const config = createTestConfig({
      jobs: { my_job: { execution: { agents: ["agent1"] } } },
      agents: {
        agent1: {
          type: "llm",
          config: { provider: "test", model: "test", prompt: "test", tools: ["github_server"] },
        },
      },
      tools: {
        mcp: {
          servers: {
            github_server: {
              command: "github-mcp",
              env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "access_token" } },
            },
          },
        },
      },
    });
    const { app } = createJobsTestApp({ config: createMergedConfig(config) });

    const res = await app.request("/my_job/ws-123");
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(body.integrations).toEqual(["github"]);
  });

  test("returns per-agent integrations from credential refs", async () => {
    const config = createTestConfig({
      jobs: { my_job: { execution: { agents: ["agent1"] } } },
      agents: {
        agent1: {
          type: "llm",
          config: { provider: "test", model: "test", prompt: "test", tools: ["github_server"] },
        },
      },
      tools: {
        mcp: {
          servers: {
            github_server: {
              command: "github-mcp",
              env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "access_token" } },
            },
          },
        },
      },
    });
    const { app } = createJobsTestApp({ config: createMergedConfig(config) });

    const res = await app.request("/my_job/ws-123");
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    const agents = body.agents as Record<string, unknown>[];
    expect(agents[0]?.integrations).toEqual([{ provider: "github", envVar: "GITHUB_TOKEN" }]);
  });

  test("returns empty integrations when no credentials", async () => {
    const config = createTestConfig({
      jobs: { my_job: { execution: { agents: ["agent1"] } } },
      agents: {
        agent1: { type: "llm", config: { provider: "test", model: "test", prompt: "test" } },
      },
    });
    const { app } = createJobsTestApp({ config: createMergedConfig(config) });

    const res = await app.request("/my_job/ws-123");
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(body.integrations).toEqual([]);
  });

  test("returns 404 for nonexistent workspace", async () => {
    const { app } = createJobsTestApp({ config: null });

    const res = await app.request("/some_job/ws-nonexistent");
    expect(res.status).toBe(404);
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(body.error).toContain("not found");
  });

  test("returns 404 for nonexistent job", async () => {
    const config = createTestConfig({
      jobs: { existing_job: { execution: { agents: ["a"] } } },
      agents: { a: { type: "llm", config: { provider: "test", model: "test", prompt: "test" } } },
    });
    const { app } = createJobsTestApp({ config: createMergedConfig(config) });

    const res = await app.request("/nonexistent_job/ws-123");
    expect(res.status).toBe(404);
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(body.error).toContain("not found");
  });

  test("resolves signals and agents with full details", async () => {
    const config = createTestConfig({
      jobs: {
        complex_job: {
          triggers: [{ signal: "http.webhook" }, { signal: "cron.hourly" }],
          execution: {
            strategy: "sequential",
            agents: ["simple_agent", { id: "detailed_agent", nickname: "planner" }],
          },
        },
      },
      signals: {
        "http.webhook": {
          description: "Incoming webhook",
          title: "Receives webhook events",
          provider: "http",
          config: { path: "/webhook" },
        },
        "cron.hourly": {
          description: "Hourly trigger",
          provider: "schedule",
          config: { schedule: "0 * * * *", timezone: "UTC" },
        },
      },
      agents: {
        simple_agent: {
          type: "llm",
          description: "A simple agent",
          config: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            prompt: "Do stuff",
            tools: ["github_server"],
          },
        },
        detailed_agent: {
          type: "llm",
          description: "A detailed agent",
          config: { provider: "anthropic", model: "claude-opus-4-6", prompt: "Plan things" },
        },
      },
      tools: {
        mcp: {
          servers: {
            github_server: {
              command: "github-mcp",
              env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "access_token" } },
            },
          },
        },
      },
    });
    const { app } = createJobsTestApp({ config: createMergedConfig(config) });

    const res = await app.request("/complex_job/ws-123");
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as Record<string, unknown>;

    expect(body.signals).toEqual({
      "http.webhook": {
        description: "Incoming webhook",
        title: "Receives webhook events",
        provider: "http",
        config: { path: "/webhook" },
      },
      "cron.hourly": {
        description: "Hourly trigger",
        provider: "schedule",
        config: { schedule: "0 * * * *", timezone: "UTC" },
      },
    });

    expect(body.agents).toEqual([
      {
        id: "simple_agent",
        type: "llm",
        description: "A simple agent",
        prompt: "Do stuff",
        model: "claude-sonnet-4-6",
        tools: ["github_server"],
        integrations: [{ provider: "github", envVar: "GITHUB_TOKEN" }],
      },
      {
        id: "detailed_agent",
        nickname: "planner",
        type: "llm",
        description: "A detailed agent",
        prompt: "Plan things",
        model: "claude-opus-4-6",
        integrations: [],
      },
    ]);
  });

  test("handles unresolved signal names gracefully", async () => {
    const config = createTestConfig({
      jobs: {
        my_job: { triggers: [{ signal: "nonexistent.signal" }], execution: { agents: ["a"] } },
      },
      agents: { a: { type: "llm", config: { provider: "test", model: "test", prompt: "test" } } },
    });
    const { app } = createJobsTestApp({ config: createMergedConfig(config) });

    const res = await app.request("/my_job/ws-123");
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(body.signals).toEqual({});
  });

  test("handles unresolved agent IDs gracefully", async () => {
    const config = createTestConfig({
      jobs: { my_job: { execution: { agents: ["nonexistent_agent"] } } },
    });
    const { app } = createJobsTestApp({ config: createMergedConfig(config) });

    const res = await app.request("/my_job/ws-123");
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(body.agents).toEqual([{ id: "nonexistent_agent", type: "unknown", integrations: [] }]);
  });

  test("resolves atlas agent type", async () => {
    const config = createTestConfig({
      jobs: { my_job: { execution: { agents: ["atlas_agent"] } } },
      agents: {
        atlas_agent: {
          type: "atlas",
          agent: "registry/my-agent",
          description: "An Atlas agent",
          prompt: "Do atlas things",
        },
      },
    });
    const { app } = createJobsTestApp({ config: createMergedConfig(config) });

    const res = await app.request("/my_job/ws-123");
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(body.agents).toEqual([
      {
        id: "atlas_agent",
        type: "atlas",
        description: "An Atlas agent",
        prompt: "Do atlas things",
        integrations: [],
      },
    ]);
  });
});
