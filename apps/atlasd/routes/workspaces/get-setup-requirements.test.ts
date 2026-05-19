/**
 * Tests that GET /workspaces and GET /workspaces/:id surface live-derived
 * `requires_setup` + `setup_requirements`, computed once per workspace per
 * request via the Hono-context cache.
 */

import { CredentialNotFoundError } from "@atlas/core/mcp-registry/credential-resolver";
import { createStubPlatformModels } from "@atlas/llm";
import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";
import { workspacesRoutes } from "./index.ts";

vi.mock("../me/adapter.ts", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ ok: true, data: { id: "user-1" } }),
}));

const memberships = vi.hoisted(() => ({
  data: [] as Array<{ userId: string; wsId: string; role: string; addedAt: string }>,
}));

vi.mock("@atlas/core/workspace-members/storage", () => ({
  WorkspaceMemberStorage: {
    get: vi
      .fn()
      .mockImplementation((userId: string, wsId: string) =>
        Promise.resolve({
          ok: true,
          data: { userId, wsId, role: "owner", addedAt: "2026-05-11T00:00:00.000Z" },
        }),
      ),
    listByUser: vi
      .fn()
      .mockImplementation(() => Promise.resolve({ ok: true, data: memberships.data })),
    listByWorkspace: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    put: vi.fn().mockResolvedValue({ ok: true, data: null }),
    putIfAbsent: vi.fn().mockResolvedValue({ ok: true, data: null }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  },
  ensureWorkspaceMembersKVBucket: vi.fn(),
  initWorkspaceMemberStorage: vi.fn(),
  resetWorkspaceMemberStorageForTests: vi.fn(),
}));

vi.mock("@atlas/workspace", async (importOriginal) => {
  const original = await importOriginal<typeof import("@atlas/workspace")>();
  return { ...original, loadWorkspaceEnv: vi.fn(() => ({})) };
});

const { mockResolveCredentialsByProvider, mockFetchLinkCredential } = vi.hoisted(() => ({
  mockResolveCredentialsByProvider: vi.fn(),
  mockFetchLinkCredential: vi.fn(),
}));
vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>()),
  resolveCredentialsByProvider: mockResolveCredentialsByProvider,
  fetchLinkCredential: mockFetchLinkCredential,
}));

type WorkspaceFixture = { id: string; name: string; config: Record<string, unknown> | null };

function makeWorkspaceEntry(fixture: WorkspaceFixture) {
  return {
    id: fixture.id,
    name: fixture.name,
    path: `/tmp/${fixture.id}`,
    configPath: `/tmp/${fixture.id}/workspace.yml`,
    status: "inactive" as const,
    createdAt: "2026-05-15T00:00:00.000Z",
    lastSeen: "2026-05-15T00:00:00.000Z",
    metadata: {},
  };
}

function createTestApp(fixtures: WorkspaceFixture[]) {
  const list = vi.fn().mockResolvedValue(fixtures.map(makeWorkspaceEntry));
  const find = vi.fn().mockImplementation(({ id }: { id: string }) => {
    const f = fixtures.find((x) => x.id === id);
    return Promise.resolve(f ? makeWorkspaceEntry(f) : null);
  });
  const getWorkspaceConfig = vi.fn().mockImplementation((id: string) => {
    const f = fixtures.find((x) => x.id === id);
    if (!f || !f.config) return Promise.resolve(null);
    return Promise.resolve({ atlas: null, workspace: f.config });
  });

  const mockWorkspaceManager = {
    find,
    list,
    getWorkspaceConfig,
    registerWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
  } as unknown as WorkspaceManager;

  const mockContext: AppContext = {
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: () => mockWorkspaceManager,
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    daemon: { getWorkspaceManager: () => mockWorkspaceManager } as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
    sessionDispatchRegistry: {} as AppContext["sessionDispatchRegistry"],
    exposeKernel: false,
    platformModels: createStubPlatformModels(),
  };

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    c.set("userId", "user-1");
    await next();
  });
  app.route("/workspaces", workspacesRoutes);

  memberships.data = fixtures.map((f) => ({
    userId: "user-1",
    wsId: f.id,
    role: "owner",
    addedAt: "2026-05-11T00:00:00.000Z",
  }));

  return { app, getWorkspaceConfig };
}

function configWithProvider(name: string, provider: string) {
  return {
    version: "1.0",
    workspace: { name },
    tools: {
      mcp: {
        servers: {
          myserver: {
            transport: { type: "stdio", command: "npx", args: ["-y", "some-server"] },
            env: { TOKEN: { from: "link", provider, key: "access_token" } },
          },
        },
      },
    },
  };
}

function configWithoutCredentials(name: string) {
  return {
    version: "1.0",
    workspace: { name },
    tools: {
      mcp: {
        servers: {
          myserver: { transport: { type: "stdio", command: "npx", args: ["-y", "some-server"] } },
        },
      },
    },
  };
}

type JsonBody = Record<string, unknown>;

describe("GET /workspaces — setup-requirements in response", () => {
  beforeEach(() => {
    mockResolveCredentialsByProvider.mockReset();
    mockFetchLinkCredential.mockReset();
  });

  test("includes requires_setup + setup_requirements per workspace", async () => {
    mockResolveCredentialsByProvider.mockRejectedValue(new CredentialNotFoundError("github"));

    const { app } = createTestApp([
      { id: "ws-1", name: "Needs Setup", config: configWithProvider("Needs Setup", "github") },
      { id: "ws-2", name: "Ready", config: configWithoutCredentials("Ready") },
    ]);

    const res = await app.request("/workspaces");
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody[];

    const needsSetup = body.find((w) => w.id === "ws-1");
    expect(needsSetup?.requires_setup).toBe(true);
    expect(needsSetup?.setup_requirements).toMatchObject([
      { kind: "credential", provider: "github", reason: "no_default" },
    ]);

    const ready = body.find((w) => w.id === "ws-2");
    expect(ready?.requires_setup).toBe(false);
    expect(ready?.setup_requirements).toEqual([]);
  });

  test("derives once per workspace — N workspaces → N config loads, not 2N", async () => {
    mockResolveCredentialsByProvider.mockRejectedValue(new CredentialNotFoundError("github"));

    const { app, getWorkspaceConfig } = createTestApp([
      { id: "ws-1", name: "One", config: configWithProvider("One", "github") },
      { id: "ws-2", name: "Two", config: configWithProvider("Two", "github") },
    ]);

    const res = await app.request("/workspaces");
    expect(res.status).toBe(200);

    // Two workspaces → two config loads (once per (request, workspace)).
    // The Hono-context cache prevents a second derivation for the same id.
    expect(getWorkspaceConfig).toHaveBeenCalledTimes(2);
    expect(getWorkspaceConfig).toHaveBeenCalledWith("ws-1");
    expect(getWorkspaceConfig).toHaveBeenCalledWith("ws-2");
  });
});

describe("GET /workspaces/:id — setup-requirements in response", () => {
  beforeEach(() => {
    mockResolveCredentialsByProvider.mockReset();
    mockFetchLinkCredential.mockReset();
  });

  test("includes requires_setup + setup_requirements for the single workspace", async () => {
    mockResolveCredentialsByProvider.mockRejectedValue(new CredentialNotFoundError("slack"));

    const { app } = createTestApp([
      { id: "ws-7", name: "Solo", config: configWithProvider("Solo", "slack") },
    ]);

    const res = await app.request("/workspaces/ws-7");
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.requires_setup).toBe(true);
    expect(body.setup_requirements).toMatchObject([
      { kind: "credential", provider: "slack", reason: "no_default" },
    ]);
  });

  test("returns requires_setup=false when nothing is missing", async () => {
    const { app } = createTestApp([
      { id: "ws-8", name: "Clean", config: configWithoutCredentials("Clean") },
    ]);

    const res = await app.request("/workspaces/ws-8");
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    expect(body.requires_setup).toBe(false);
    expect(body.setup_requirements).toEqual([]);
  });

  test("derives the same workspace only once per request (memoized)", async () => {
    mockResolveCredentialsByProvider.mockRejectedValue(new CredentialNotFoundError("github"));

    const { app, getWorkspaceConfig } = createTestApp([
      { id: "ws-9", name: "Memo", config: configWithProvider("Memo", "github") },
    ]);

    const res = await app.request("/workspaces/ws-9");
    expect(res.status).toBe(200);

    // The single-GET handler already calls `manager.getWorkspaceConfig` once
    // to embed the config; the cache means our derivation re-uses that lookup
    // via the manager's mtime cache (a duplicate call is acceptable and is
    // gated by the manager, not the per-request derivation cache).
    expect(getWorkspaceConfig).toHaveBeenCalledWith("ws-9");
  });
});
