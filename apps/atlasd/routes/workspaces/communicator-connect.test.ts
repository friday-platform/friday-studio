/**
 * Route tests for POST /:workspaceId/connect-communicator and
 * /:workspaceId/disconnect-communicator. Mirror slack-connect.test.ts shape:
 * real workspace.yml on disk, real applyMutation; only Link HTTP and the
 * credential-fetch helper are mocked.
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

vi.mock("../me/adapter.ts", () => ({ getCurrentUser: vi.fn().mockResolvedValue({ ok: false }) }));

const mockDeriveConnectionId = vi.hoisted(() =>
  vi.fn<(kind: string, credentialId: string) => Promise<string>>(),
);
const mockWireCommunicator = vi.hoisted(() =>
  vi.fn<
    (
      workspaceId: string,
      provider: string,
      credentialId: string,
      connectionId: string,
      callbackBaseUrl: string,
    ) => Promise<void>
  >(),
);
const mockDisconnectCommunicator = vi.hoisted(() =>
  vi.fn<
    (
      workspaceId: string,
      provider: string,
      callbackBaseUrl: string,
    ) => Promise<{ credentialId: string | null }>
  >(),
);
const mockResolveTunnelUrl = vi.hoisted(() => vi.fn<() => Promise<string>>());

vi.mock("../../src/services/communicator-wiring.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/services/communicator-wiring.ts")>();
  return {
    ...original,
    deriveConnectionId: mockDeriveConnectionId,
    wireCommunicator: mockWireCommunicator,
    disconnectCommunicator: mockDisconnectCommunicator,
    resolveTunnelUrl: mockResolveTunnelUrl,
  };
});

let workspacePath: string;

beforeEach(async () => {
  workspacePath = join(
    tmpdir(),
    `atlas-communicator-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(workspacePath, { recursive: true });

  mockDeriveConnectionId.mockReset().mockResolvedValue("derived-connection-id");
  mockWireCommunicator.mockReset().mockResolvedValue(undefined);
  mockDisconnectCommunicator.mockReset().mockResolvedValue({ credentialId: "cred-42" });
  mockResolveTunnelUrl.mockReset().mockResolvedValue("https://tunnel.example.com");
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

function configWithTelegramCommunicator() {
  return {
    version: "1.0",
    workspace: { id: "ws-1", name: "Test" },
    communicators: { telegram: { kind: "telegram" } },
  };
}

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
    find: vi.fn((q?: { id?: string }) => Promise.resolve(q?.id === "ws-1" ? workspace : null)),
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
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    evictChatSdkInstance,
    daemon: { getWorkspaceManager: () => mockWorkspaceManager } as AppContext["daemon"],
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

  const { workspacesRoutes } = await import("./index.ts");
  app.route("/", workspacesRoutes);

  return { app, evictChatSdkInstance };
}

describe("POST /:workspaceId/connect-communicator", () => {
  test("happy path: wires Link, writes kind-only block to yml, evicts chat-sdk", async () => {
    await writeWorkspaceConfig(emptyConfig());
    const { app, evictChatSdkInstance } = await createTestApp();

    const res = await app.request("/ws-1/connect-communicator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "telegram", credential_id: "cred-77" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, kind: "telegram" });

    expect(mockDeriveConnectionId).toHaveBeenCalledWith("telegram", "cred-77");
    expect(mockWireCommunicator).toHaveBeenCalledWith(
      "ws-1",
      "telegram",
      "cred-77",
      "derived-connection-id",
      "https://tunnel.example.com",
    );

    const written = (await readWorkspaceConfig()) as { communicators?: Record<string, unknown> };
    expect(written.communicators).toEqual({ telegram: { kind: "telegram" } });
    // No bot_token / webhook_secret in yml — Link owns secrets.
    expect(written.communicators?.telegram).not.toHaveProperty("bot_token");
    expect(evictChatSdkInstance).toHaveBeenCalledWith("ws-1");
  });

  test("idempotent: posting twice produces the same yml block", async () => {
    await writeWorkspaceConfig(emptyConfig());
    const { app } = await createTestApp();

    await app.request("/ws-1/connect-communicator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "telegram", credential_id: "cred-77" }),
    });
    const res2 = await app.request("/ws-1/connect-communicator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "telegram", credential_id: "cred-77" }),
    });

    expect(res2.status).toBe(200);
    const written = (await readWorkspaceConfig()) as { communicators?: Record<string, unknown> };
    expect(written.communicators).toEqual({ telegram: { kind: "telegram" } });
  });

  test("kind: slack flows through the generic path and wires Link", async () => {
    await writeWorkspaceConfig(emptyConfig());
    const { app } = await createTestApp();

    const res = await app.request("/ws-1/connect-communicator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "slack", credential_id: "cred-slack" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, kind: "slack" });

    expect(mockDeriveConnectionId).toHaveBeenCalledWith("slack", "cred-slack");
    expect(mockWireCommunicator).toHaveBeenCalledWith(
      "ws-1",
      "slack",
      "cred-slack",
      "derived-connection-id",
      "https://tunnel.example.com",
    );
    const written = (await readWorkspaceConfig()) as { communicators?: Record<string, unknown> };
    expect(written.communicators).toEqual({ slack: { kind: "slack" } });
  });

  test("404 on unknown workspace", async () => {
    await writeWorkspaceConfig(emptyConfig());
    const { app } = await createTestApp();

    const res = await app.request("/ws-missing/connect-communicator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "telegram", credential_id: "cred-77" }),
    });

    expect(res.status).toBe(404);
    expect(mockWireCommunicator).not.toHaveBeenCalled();
  });

  test("Link wire failure leaves yml untouched and does NOT evict chat-sdk", async () => {
    await writeWorkspaceConfig(emptyConfig());
    mockWireCommunicator.mockRejectedValueOnce(new Error("Link wire returned 500"));
    const { app, evictChatSdkInstance } = await createTestApp();

    const res = await app.request("/ws-1/connect-communicator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "telegram", credential_id: "cred-77" }),
    });

    expect(res.status).toBe(500);
    expect((await readWorkspaceConfig()).communicators).toBeUndefined();
    expect(evictChatSdkInstance).not.toHaveBeenCalled();
  });

  test("tunnel unavailable: connect fails before touching wiring or yml", async () => {
    await writeWorkspaceConfig(emptyConfig());
    mockResolveTunnelUrl.mockRejectedValueOnce(
      new Error("Public tunnel not available. Start it with 'deno task webhook-tunnel'."),
    );
    const { app } = await createTestApp();

    const res = await app.request("/ws-1/connect-communicator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "telegram", credential_id: "cred-77" }),
    });

    expect(res.status).toBe(500);
    expect(mockWireCommunicator).not.toHaveBeenCalled();
    expect((await readWorkspaceConfig()).communicators).toBeUndefined();
  });
});

describe("POST /:workspaceId/disconnect-communicator", () => {
  test("happy path: removes yml block, calls Link disconnect, evicts chat-sdk", async () => {
    await writeWorkspaceConfig(configWithTelegramCommunicator());
    const { app, evictChatSdkInstance } = await createTestApp();

    const res = await app.request("/ws-1/disconnect-communicator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "telegram" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, credential_id: "cred-42" });

    const written = (await readWorkspaceConfig()) as { communicators?: Record<string, unknown> };
    expect(written.communicators).toBeUndefined();
    expect(mockDisconnectCommunicator).toHaveBeenCalledWith(
      "ws-1",
      "telegram",
      "https://tunnel.example.com",
    );
    expect(evictChatSdkInstance).toHaveBeenCalledWith("ws-1");
  });

  test("idempotent when no communicator block exists", async () => {
    await writeWorkspaceConfig(emptyConfig());
    mockDisconnectCommunicator.mockResolvedValueOnce({ credentialId: null });
    const { app } = await createTestApp();

    const res = await app.request("/ws-1/disconnect-communicator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "telegram" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, credential_id: null });
  });

  test("kind: slack flows through generic disconnect and calls Link", async () => {
    await writeWorkspaceConfig({
      version: "1.0",
      workspace: { id: "ws-1", name: "Test" },
      communicators: { slack: { kind: "slack" } },
    });
    const { app } = await createTestApp();

    const res = await app.request("/ws-1/disconnect-communicator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "slack" }),
    });

    expect(res.status).toBe(200);
    expect(mockDisconnectCommunicator).toHaveBeenCalledWith(
      "ws-1",
      "slack",
      "https://tunnel.example.com",
    );
    const written = (await readWorkspaceConfig()) as { communicators?: Record<string, unknown> };
    expect(written.communicators).toBeUndefined();
  });

  test("tunnel unavailable: disconnect proceeds with empty callback URL", async () => {
    await writeWorkspaceConfig(configWithTelegramCommunicator());
    mockResolveTunnelUrl.mockRejectedValueOnce(new Error("Public tunnel not available."));
    const { app, evictChatSdkInstance } = await createTestApp();

    const res = await app.request("/ws-1/disconnect-communicator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "telegram" }),
    });

    expect(res.status).toBe(200);
    expect(mockDisconnectCommunicator).toHaveBeenCalledWith("ws-1", "telegram", "");
    expect((await readWorkspaceConfig()).communicators).toBeUndefined();
    expect(evictChatSdkInstance).toHaveBeenCalledWith("ws-1");
  });
});
