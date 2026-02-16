/**
 * Input validation tests for workspace routes (POST /add, POST /add-batch,
 * POST /:workspaceId/update).
 *
 * Tests that zValidator rejects invalid payloads before handlers execute.
 */

import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";
import { workspacesRoutes } from "./index.ts";

// Mock external dependencies that route handlers import
vi.mock("@atlas/analytics", () => ({
  createAnalyticsClient: () => ({ emit: vi.fn() }),
  EventNames: { WORKSPACE_CREATED: "workspace.created" },
}));
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
    getLibraryStorage: vi.fn(),
    getAgentRegistry: vi.fn(),
    daemon: {
      getWorkspaceManager: () => mockWorkspaceManager,
      runtimes: new Map(),
    } as unknown as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
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
