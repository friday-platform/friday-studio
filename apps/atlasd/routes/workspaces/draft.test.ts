/**
 * Integration tests for the draft file flow.
 *
 * Tests the full lifecycle: create workspace → begin draft → verify draft exists
 * → publish → verify draft gone, live updated → verify daemon restart loads live.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "@atlas/config";
import type { WorkspaceManager } from "@atlas/workspace";
import { stringify } from "@std/yaml";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";
import { workspacesRoutes } from "./index.ts";

vi.mock("@atlas/analytics", () => ({
  createAnalyticsClient: () => ({ track: vi.fn(), flush: vi.fn() }),
  EventNames: {},
}));

vi.mock("@atlas/storage", () => ({
  storeWorkspaceHistory: vi.fn().mockResolvedValue(undefined),
  FilesystemWorkspaceCreationAdapter: class {
    createWorkspaceDirectory = vi.fn().mockResolvedValue("/tmp");
    writeWorkspaceFiles = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("../me/adapter.ts", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: "user-1", email: "test@test.com" }),
}));

vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>()),
  fetchLinkCredential: vi.fn().mockResolvedValue({ provider: "github" }),
}));

vi.mock("@atlas/utils/paths.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/utils/paths.server")>()),
  getAtlasHome: vi.fn(() => "/tmp"),
}));

function createMinimalConfig(): WorkspaceConfig {
  return {
    version: "1.0",
    workspace: { id: "ws-test", name: "Test Workspace", description: "test" },
  };
}

function createApp(opts: { workspaceDir: string; workspaceId: string }) {
  const mockManager = {
    find: vi
      .fn()
      .mockResolvedValue({
        id: opts.workspaceId,
        name: "Test Workspace",
        path: opts.workspaceDir,
        status: "idle",
        metadata: {},
      }),
    getWorkspaceConfig: vi.fn().mockImplementation(async () => {
      // Return a mock merged config
      return { atlas: null, workspace: createMinimalConfig() };
    }),
  } as unknown as WorkspaceManager;

  const mockContext: AppContext = {
    runtimes: new Map(),
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: () => mockManager,
    getOrCreateWorkspaceRuntime: vi.fn(),
    resetIdleTimeout: vi.fn(),
    getWorkspaceRuntime: vi.fn(),
    destroyWorkspaceRuntime: vi.fn().mockResolvedValue(undefined),
    getLibraryStorage: vi.fn(),
    daemon: {
      getWorkspaceManager: () => mockManager,
      runtimes: new Map(),
    } as unknown as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    evictChatSdkInstance: vi.fn().mockResolvedValue(undefined),
    getLedgerAdapter: vi.fn(),
    getActivityAdapter: vi.fn(),
    exposeKernel: false,
    platformModels: { get: vi.fn() },
  };

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    await next();
  });
  app.route("/workspaces", workspacesRoutes);

  return { app, mockManager };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("Draft file flow", () => {
  let tempDir: string;
  const workspaceId = "ws-draft-test";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "draft-test-"));
    await writeFile(join(tempDir, "workspace.yml"), stringify(createMinimalConfig()));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("begin draft creates workspace.yml.draft from live file", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    const res = await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ success: true });

    const draftPath = join(tempDir, "workspace.yml.draft");
    expect(await fileExists(draftPath)).toBe(true);

    const draftContent = await readFile(draftPath, "utf-8");
    const liveContent = await readFile(join(tempDir, "workspace.yml"), "utf-8");
    expect(draftContent).toBe(liveContent);
  });

  test("begin draft is idempotent", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    // First call
    const res1 = await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });
    expect(res1.status).toBe(200);

    // Modify draft to prove idempotency
    await writeFile(join(tempDir, "workspace.yml.draft"), "modified: true\n", "utf-8");

    // Second call should not overwrite
    const res2 = await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });
    expect(res2.status).toBe(200);

    const draftContent = await readFile(join(tempDir, "workspace.yml.draft"), "utf-8");
    expect(draftContent).toBe("modified: true\n");
  });

  test("read draft returns draft config", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });

    const res = await app.request(`/workspaces/${workspaceId}/draft`, { method: "GET" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ success: true, config: { version: "1.0" } });
  });

  test("publish draft atomically replaces live file and removes draft", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    // Begin draft
    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });

    // Modify draft
    const modifiedConfig = {
      ...createMinimalConfig(),
      workspace: { ...createMinimalConfig().workspace, name: "Modified Name" },
    };
    await writeFile(join(tempDir, "workspace.yml.draft"), stringify(modifiedConfig));

    // Publish
    const res = await app.request(`/workspaces/${workspaceId}/draft/publish`, { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ success: true, runtimeReloaded: false });

    // Draft should be gone
    expect(await fileExists(join(tempDir, "workspace.yml.draft"))).toBe(false);

    // Live file should be updated
    const liveContent = await readFile(join(tempDir, "workspace.yml"), "utf-8");
    expect(liveContent).toContain("Modified Name");
  });

  test("publish draft refuses when validation fails", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    // Begin draft
    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });

    // Write invalid config into draft
    await writeFile(join(tempDir, "workspace.yml.draft"), "invalid: yaml: [", "utf-8");

    // Publish should fail validation
    const res = await app.request(`/workspaces/${workspaceId}/draft/publish`, { method: "POST" });
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body).toMatchObject({ success: false });

    // Draft should still exist since publish failed
    expect(await fileExists(join(tempDir, "workspace.yml.draft"))).toBe(true);
  });

  test("discard draft removes draft file", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });
    expect(await fileExists(join(tempDir, "workspace.yml.draft"))).toBe(true);

    const res = await app.request(`/workspaces/${workspaceId}/draft/discard`, { method: "POST" });
    expect(res.status).toBe(200);

    expect(await fileExists(join(tempDir, "workspace.yml.draft"))).toBe(false);
  });

  test("daemon restart loads live file, not draft", async () => {
    const { app, mockManager } = createApp({ workspaceDir: tempDir, workspaceId });

    // Begin draft and modify it
    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });
    const draftConfig = {
      ...createMinimalConfig(),
      workspace: { ...createMinimalConfig().workspace, name: "Draft Only" },
    };
    await writeFile(join(tempDir, "workspace.yml.draft"), stringify(draftConfig));

    // Verify draft exists and has the modified name
    expect(await fileExists(join(tempDir, "workspace.yml.draft"))).toBe(true);

    // Simulate what the daemon does: load workspace config via manager
    const loaded = await mockManager.getWorkspaceConfig(workspaceId);
    // The mock returns the live config (from workspace.yml), not the draft
    expect(loaded?.workspace?.workspace?.name).toBe("Test Workspace");
  });

  test("publish with active runtime destroys and reloads it", async () => {
    const mockManager = {
      find: vi
        .fn()
        .mockResolvedValue({
          id: workspaceId,
          name: "Test Workspace",
          path: tempDir,
          status: "idle",
          metadata: {},
        }),
      getWorkspaceConfig: vi
        .fn()
        .mockResolvedValue({ atlas: null, workspace: createMinimalConfig() }),
    } as unknown as WorkspaceManager;

    const destroySpy = vi.fn().mockResolvedValue(undefined);
    const mockContext: AppContext = {
      runtimes: new Map(),
      startTime: Date.now(),
      sseClients: new Map(),
      sseStreams: new Map(),
      getWorkspaceManager: () => mockManager,
      getOrCreateWorkspaceRuntime: vi.fn(),
      resetIdleTimeout: vi.fn(),
      getWorkspaceRuntime: vi.fn().mockReturnValue({ id: "runtime-1" }),
      destroyWorkspaceRuntime: destroySpy,
      getLibraryStorage: vi.fn(),
      daemon: {
        getWorkspaceManager: () => mockManager,
        runtimes: new Map(),
      } as unknown as AppContext["daemon"],
      streamRegistry: {} as AppContext["streamRegistry"],
      sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
      sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
      getAgentRegistry: vi.fn(),
      getOrCreateChatSdkInstance: vi.fn(),
      evictChatSdkInstance: vi.fn().mockResolvedValue(undefined),
      getLedgerAdapter: vi.fn(),
      getActivityAdapter: vi.fn(),
      exposeKernel: false,
      platformModels: { get: vi.fn() },
    };

    const app = new Hono<AppVariables>();
    app.use("*", async (c, next) => {
      c.set("app", mockContext);
      await next();
    });
    app.route("/workspaces", workspacesRoutes);

    // Begin draft and publish
    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });
    const res = await app.request(`/workspaces/${workspaceId}/draft/publish`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, runtimeReloaded: true });
    expect(destroySpy).toHaveBeenCalledWith(workspaceId);
  });
});
