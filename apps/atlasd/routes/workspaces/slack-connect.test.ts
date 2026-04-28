/**
 * Route tests for POST /:workspaceId/connect-slack and /:workspaceId/disconnect-slack.
 *
 * Strategy: real workspace.yml on disk, real applyMutation. Mocks are limited
 * to HTTP boundaries (Link service) and analytics. After each mutation we
 * read the YAML back to verify the actual write — not just "the mock was
 * called with X".
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStubPlatformModels } from "@atlas/llm";
import type { WorkspaceManager } from "@atlas/workspace";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";

vi.mock("@atlas/analytics", () => ({
  createAnalyticsClient: () => ({ emit: vi.fn(), track: vi.fn(), flush: vi.fn() }),
  EventNames: { WORKSPACE_CREATED: "workspace.created" },
}));

vi.mock("../me/adapter.ts", () => ({ getCurrentUser: vi.fn().mockResolvedValue({ ok: false }) }));

// HTTP boundary mocks — these hit the Link service in real life.
const mockResolveSlackAppByWorkspace = vi.hoisted(() =>
  vi.fn<(workspaceId: string) => Promise<{ credentialId: string; appId: string } | null>>(),
);
const mockDeleteSlackApp = vi.hoisted(() => vi.fn<(appId: string) => Promise<void>>());
vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>();
  return {
    ...original,
    resolveSlackAppByWorkspace: mockResolveSlackAppByWorkspace,
    deleteSlackApp: mockDeleteSlackApp,
  };
});

const mockWireToWorkspace = vi.hoisted(() =>
  vi.fn<
    (
      credentialId: string,
      workspaceId: string,
      name: string,
      description?: string,
    ) => Promise<string>
  >(),
);
const mockEnableEvents = vi.hoisted(() => vi.fn<(credentialId: string) => Promise<void>>());
const mockDisableEvents = vi.hoisted(() => vi.fn<(credentialId: string) => Promise<void>>());
vi.mock("../../src/services/slack-auto-wire.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/services/slack-auto-wire.ts")>();
  return {
    ...original,
    createLinkWireClient: () => mockWireToWorkspace,
    enableSlackEventSubscriptions: mockEnableEvents,
    disableSlackEventSubscriptions: mockDisableEvents,
  };
});

// ---------------------------------------------------------------------------
// Tempdir + workspace.yml fixtures
// ---------------------------------------------------------------------------

let workspacePath: string;

beforeEach(async () => {
  workspacePath = join(
    tmpdir(),
    `atlas-slack-connect-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(workspacePath, { recursive: true });

  mockResolveSlackAppByWorkspace.mockReset();
  mockDeleteSlackApp.mockReset().mockResolvedValue(undefined);
  mockWireToWorkspace.mockReset();
  mockEnableEvents.mockReset().mockResolvedValue(undefined);
  mockDisableEvents.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

async function writeWorkspaceConfig(config: Record<string, unknown>): Promise<void> {
  await writeFile(join(workspacePath, "workspace.yml"), stringifyYaml(config), "utf-8");
}

async function readWorkspaceConfig(): Promise<Record<string, unknown>> {
  const yaml = await readFile(join(workspacePath, "workspace.yml"), "utf-8");
  return parseYaml(yaml) as Record<string, unknown>;
}

function emptyConfig() {
  return { version: "1.0", workspace: { id: "ws-1", name: "Test" } };
}

function configWithSlackSignal() {
  return {
    version: "1.0",
    workspace: { id: "ws-1", name: "Test" },
    signals: {
      slack: { provider: "slack", description: "Slack messages", config: { app_id: "A123" } },
    },
  };
}

function configWithBundledSlackAgent() {
  return {
    ...configWithSlackSignal(),
    agents: {
      slackComm: {
        type: "atlas",
        agent: "slack",
        description: "Slack communicator",
        prompt: "post messages to slack",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Test app — real applyMutation reads/writes workspace.yml in tempdir.
// The workspace manager is a thin shim: find() returns the tempdir path,
// getWorkspaceConfig() re-parses the file each call so it sees what
// applyMutation just wrote.
// ---------------------------------------------------------------------------

async function createTestApp() {
  const workspace = {
    id: "ws-1",
    name: "Test",
    path: workspacePath,
    configPath: join(workspacePath, "workspace.yml"),
    status: "inactive" as const,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    metadata: {},
  };

  const mockWorkspaceManager = {
    find: vi.fn().mockResolvedValue(workspace),
    getWorkspaceConfig: vi.fn(async () => ({
      atlas: null,
      workspace: await readWorkspaceConfig(),
    })),
    list: vi.fn().mockResolvedValue([]),
    registerWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
  } as unknown as WorkspaceManager;

  const evictChatSdkInstance = vi.fn().mockResolvedValue(undefined);

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
    evictChatSdkInstance,
    getLedgerAdapter: vi.fn(),
    getActivityAdapter: vi.fn(),
    daemon: { getWorkspaceManager: () => mockWorkspaceManager } as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
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

  const { workspacesRoutes } = await import("./index.ts");
  app.route("/", workspacesRoutes);

  return { app, evictChatSdkInstance };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /:workspaceId/connect-slack", () => {
  test("idempotent when a slack signal already exists — no wire, no events", async () => {
    await writeWorkspaceConfig(configWithSlackSignal());
    const { app } = await createTestApp();

    const res = await app.request("/ws-1/connect-slack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, alreadyConnected: true, app_id: "A123" });
    expect(mockWireToWorkspace).not.toHaveBeenCalled();
    expect(mockEnableEvents).not.toHaveBeenCalled();
  });

  test("probe with no wired credential returns installRequired and writes nothing", async () => {
    await writeWorkspaceConfig(emptyConfig());
    mockResolveSlackAppByWorkspace.mockResolvedValue(null);
    const { app } = await createTestApp();

    const res = await app.request("/ws-1/connect-slack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, installRequired: true });
    // Disk is unchanged.
    expect((await readWorkspaceConfig()).signals).toBeUndefined();
    expect(mockEnableEvents).not.toHaveBeenCalled();
  });

  test("reuses an already-wired credential: writes signal to disk, enables events, evicts cache", async () => {
    await writeWorkspaceConfig(emptyConfig());
    mockResolveSlackAppByWorkspace.mockResolvedValue({ credentialId: "cred-99", appId: "A999" });
    const { app, evictChatSdkInstance } = await createTestApp();

    const res = await app.request("/ws-1/connect-slack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, app_id: "A999" });

    // The signal was actually written to workspace.yml.
    const written = (await readWorkspaceConfig()) as {
      signals?: Record<string, { provider: string; config: { app_id: string } }>;
    };
    const slackSignal = Object.values(written.signals ?? {}).find((s) => s.provider === "slack");
    expect(slackSignal?.config.app_id).toBe("A999");

    expect(mockWireToWorkspace).not.toHaveBeenCalled();
    expect(mockEnableEvents).toHaveBeenCalledWith("cred-99");
    expect(evictChatSdkInstance).toHaveBeenCalledWith("ws-1");
  });
});

describe("POST /:workspaceId/disconnect-slack", () => {
  test("idempotent when no slack signal exists", async () => {
    await writeWorkspaceConfig(emptyConfig());
    const { app, evictChatSdkInstance } = await createTestApp();

    const res = await app.request("/ws-1/disconnect-slack", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, alreadyDisconnected: true });
    expect(mockDisableEvents).not.toHaveBeenCalled();
    expect(mockDeleteSlackApp).not.toHaveBeenCalled();
    expect(evictChatSdkInstance).not.toHaveBeenCalled();
  });

  test("removes signal from disk, disables events, deletes Slack app when nothing else needs it", async () => {
    await writeWorkspaceConfig(configWithSlackSignal());
    mockResolveSlackAppByWorkspace.mockResolvedValue({ credentialId: "cred-42", appId: "A123" });
    const { app, evictChatSdkInstance } = await createTestApp();

    const res = await app.request("/ws-1/disconnect-slack", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deletedApp: true });

    // Signal removed from disk.
    const after = (await readWorkspaceConfig()) as { signals?: Record<string, unknown> };
    expect(Object.keys(after.signals ?? {})).toHaveLength(0);

    expect(mockDisableEvents).toHaveBeenCalledWith("cred-42");
    expect(mockDeleteSlackApp).toHaveBeenCalledWith("A123");
    expect(evictChatSdkInstance).toHaveBeenCalledWith("ws-1");
  });

  test("keeps Slack app when a bundled Slack agent still implicitly references it", async () => {
    await writeWorkspaceConfig(configWithBundledSlackAgent());
    mockResolveSlackAppByWorkspace.mockResolvedValue({ credentialId: "cred-42", appId: "A123" });
    const { app } = await createTestApp();

    const res = await app.request("/ws-1/disconnect-slack", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deletedApp: false });
    expect(mockDisableEvents).toHaveBeenCalledWith("cred-42");
    expect(mockDeleteSlackApp).not.toHaveBeenCalled();
  });
});
