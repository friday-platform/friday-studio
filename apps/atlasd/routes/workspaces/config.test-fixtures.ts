/**
 * Test fixtures for workspace config route tests.
 *
 * Route-specific helpers for HTTP integration tests. Signal/agent factories
 * (httpSignal, llmAgent, etc.) are imported from @atlas/config/testing.
 *
 * This file contains:
 * - createTestConfig/createMergedConfig: Loosely-typed for mocked data
 * - createMockWorkspace/createTestApp: Hono app setup with mocked context
 * - assert404WorkspaceNotFound: HTTP assertion helper
 * - useTempDir: Temp directory lifecycle for file-writing tests
 */

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MergedConfig, WorkspaceConfig } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import { afterEach, beforeEach, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";
import { configRoutes } from "./config.ts";

/**
 * Create a minimal valid WorkspaceConfig for testing.
 *
 * Uses loose typing with `as WorkspaceConfig` because route tests mock data that
 * bypasses Zod parsing. The workspace manager mock returns this config directly,
 * so we don't need strict type compliance. This allows tests to use inline objects
 * without importing every factory helper.
 *
 * For strictly-typed configs (mutation tests), use @atlas/config/testing instead.
 */
export function createTestConfig(overrides: Record<string, unknown> = {}): WorkspaceConfig {
  return {
    version: "1.0",
    workspace: { id: "test-workspace", name: "Test Workspace" },
    ...overrides,
  } as WorkspaceConfig;
}

/**
 * Create a MergedConfig wrapping a WorkspaceConfig.
 */
export function createMergedConfig(workspaceConfig: WorkspaceConfig): MergedConfig {
  return { atlas: null, workspace: workspaceConfig };
}

/**
 * Create a mock workspace entry.
 */
export function createMockWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-test-id",
    name: "Test Workspace",
    path: "/tmp/test-workspace",
    configPath: "/tmp/test-workspace/workspace.yml",
    status: "inactive" as const,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

/**
 * Create a test app with mocked context for route testing.
 */
export function createTestApp(options: {
  workspace?: ReturnType<typeof createMockWorkspace> | null;
  config?: MergedConfig | null;
  runtimeActive?: boolean;
}) {
  const { workspace = createMockWorkspace(), config = null, runtimeActive = false } = options;

  const destroyWorkspaceRuntime = vi.fn().mockResolvedValue(undefined);
  const getWorkspaceRuntime = vi.fn().mockReturnValue(runtimeActive ? {} : undefined);

  // Create a partial mock that satisfies the routes' needs
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
    getWorkspaceRuntime,
    destroyWorkspaceRuntime,
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

  // Add middleware to set context
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    await next();
  });

  // Mount config routes at /:workspaceId/config to match real mounting
  app.route("/:workspaceId/config", configRoutes);

  return { app, mockContext, destroyWorkspaceRuntime, getWorkspaceRuntime };
}

/** Type for generic JSON response body */
export type JsonBody = Record<string, unknown>;

/**
 * Assert a route returns 404 for workspace not found.
 *
 * Handles both GET and mutation (POST/PUT/DELETE) requests.
 * Extracts workspaceId from path for entityId assertion.
 */
export async function assert404WorkspaceNotFound(
  app: ReturnType<typeof createTestApp>["app"],
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  requestBody?: Record<string, unknown>,
): Promise<void> {
  const { expect } = await import("vitest");

  const requestInit: RequestInit =
    method === "GET"
      ? {}
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody ?? {}),
        };

  const response = await app.request(path, requestInit);

  expect(response.status).toBe(404);
  const body = (await response.json()) as JsonBody;
  expect(body.success).toBe(false);
  expect(body.error).toBe("not_found");
  expect(body.entityType).toBe("workspace");

  // Extract workspaceId from path (first segment after leading slash)
  const workspaceId = path.split("/")[1];
  expect(body.entityId).toBe(workspaceId);
}

/**
 * Creates a temp directory before each test and cleans up after.
 *
 * Returns a getter function to access the current test's directory path.
 * Must be called at the top level of a describe block.
 *
 * @example
 * describe("my tests", () => {
 *   const getTestDir = useTempDir();
 *
 *   test("uses temp dir", async () => {
 *     const dir = getTestDir();
 *     await writeFile(join(dir, "test.yml"), "...");
 *   });
 * });
 */
export function useTempDir(): () => string {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `atlas-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  return () => testDir;
}
