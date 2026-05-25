/**
 * Tests for GET /api/workspaces/:workspaceId/variables.
 *
 * Covers the four endpoint-level cases from the design's Testing Decisions:
 * #1 shape (one row per declaration, empty array when no `variables:` block),
 * #2 `source` discriminator over env/default/unset, #3 `validation_error` when
 * the env value fails the declared schema, #4 authz — 403 for non-members and
 * 404 for missing workspaces, matching the env.ts neighbor.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VariableDeclaration, WorkspaceConfig } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";

const membershipMocks = vi.hoisted(() => ({
  get: vi
    .fn()
    .mockImplementation((userId: string, wsId: string) =>
      Promise.resolve({
        ok: true,
        data: { userId, wsId, role: "owner", addedAt: "2026-05-11T00:00:00.000Z" },
      }),
    ),
  listByUser: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  listByWorkspace: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  put: vi.fn().mockResolvedValue({ ok: true, data: null }),
  putIfAbsent: vi.fn().mockResolvedValue({ ok: true, data: null }),
  delete: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
}));

vi.mock("@atlas/core/workspace-members/storage", () => ({
  WorkspaceMemberStorage: membershipMocks,
  ensureWorkspaceMembersKVBucket: vi.fn(),
  initWorkspaceMemberStorage: vi.fn(),
  resetWorkspaceMemberStorageForTests: vi.fn(),
}));

const { workspaceVariablesRoutes } = await import("./variables.ts");

type JsonBody = Record<string, unknown>;

interface VariableRow {
  name: string;
  declaration: VariableDeclaration;
  value: string | null;
  effective_value: string | null;
  source: "env" | "default" | "unset";
  is_filled: boolean;
  validation_error?: string;
}

function makeWorkspaceEntry(workspacePath: string) {
  return {
    id: "ws-test",
    name: "Test Workspace",
    path: workspacePath,
    configPath: join(workspacePath, "workspace.yml"),
    status: "inactive" as const,
    createdAt: "2026-05-15T00:00:00.000Z",
    lastSeen: "2026-05-15T00:00:00.000Z",
    metadata: {},
  };
}

function createTestApp(options: {
  workspacePath: string;
  workspaceFound?: boolean;
  variables?: Record<string, VariableDeclaration>;
}) {
  const { workspacePath, workspaceFound = true, variables } = options;
  const entry = workspaceFound ? makeWorkspaceEntry(workspacePath) : null;
  const workspaceConfig: WorkspaceConfig = {
    version: "1.0",
    workspace: { id: "ws-test", name: "Test Workspace" },
    ...(variables !== undefined ? { variables } : {}),
  } as WorkspaceConfig;

  const mockWorkspaceManager = {
    find: vi.fn().mockResolvedValue(entry),
    getWorkspaceConfig: vi
      .fn()
      .mockResolvedValue(workspaceFound ? { atlas: null, workspace: workspaceConfig } : null),
    list: vi.fn().mockResolvedValue([]),
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
    daemon: {} as AppContext["daemon"],
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
    c.set("userId", "test-user");
    await next();
  });
  app.route("/:workspaceId/variables", workspaceVariablesRoutes);

  return { app, mockWorkspaceManager };
}

function useTempWorkspaceDir(): () => string {
  let dir: string;
  beforeEach(async () => {
    dir = join(
      tmpdir(),
      `atlas-variables-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return () => dir;
}

const stringDecl: VariableDeclaration = { display_name: "Recipient", schema: { type: "string" } };

const stringWithDefaultDecl: VariableDeclaration = {
  schema: { type: "string", default: "fallback@example.com" },
};

const integerDecl: VariableDeclaration = {
  display_name: "Threshold",
  schema: { type: "integer", minimum: 0 },
};

describe("GET /api/workspaces/:workspaceId/variables", () => {
  beforeEach(() => {
    membershipMocks.get.mockImplementation((userId: string, wsId: string) =>
      Promise.resolve({
        ok: true,
        data: { userId, wsId, role: "owner", addedAt: "2026-05-11T00:00:00.000Z" },
      }),
    );
  });

  // Test case #1 — endpoint shape: one row per declaration in declaration order.
  describe("shape", () => {
    const getDir = useTempWorkspaceDir();

    test("returns one entry per declared variable, in declaration order", async () => {
      const dir = getDir();
      await writeFile(join(dir, ".env"), "EMAIL_RECIPIENT=alice@example.com\n");

      const { app } = createTestApp({
        workspacePath: dir,
        variables: { email_recipient: stringDecl, threshold: integerDecl },
      });

      const res = await app.request("/ws-test/variables");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: true; variables: VariableRow[] };
      expect(body.success).toBe(true);
      expect(body.variables.map((v) => v.name)).toEqual(["email_recipient", "threshold"]);
    });

    test("workspace with no `variables:` block returns success: true and empty array", async () => {
      const dir = getDir();
      const { app } = createTestApp({ workspacePath: dir });

      const res = await app.request("/ws-test/variables");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: true; variables: VariableRow[] };
      expect(body).toEqual({ success: true, variables: [] });
    });
  });

  // Test case #2 — source discriminator: env / default / unset.
  describe("source", () => {
    const getDir = useTempWorkspaceDir();

    test("source is `env` when env carries a passing value", async () => {
      const dir = getDir();
      await writeFile(join(dir, ".env"), "EMAIL_RECIPIENT=alice@example.com\n");

      const { app } = createTestApp({
        workspacePath: dir,
        variables: { email_recipient: stringDecl },
      });

      const res = await app.request("/ws-test/variables");
      const body = (await res.json()) as { variables: VariableRow[] };
      expect(body.variables[0]).toMatchObject({
        name: "email_recipient",
        source: "env",
        value: "alice@example.com",
        effective_value: "alice@example.com",
        is_filled: true,
      });
      expect(body.variables[0]?.validation_error).toBeUndefined();
    });

    test("source is `default` when env is absent and schema.default is set", async () => {
      const dir = getDir();

      const { app } = createTestApp({
        workspacePath: dir,
        variables: { email_recipient: stringWithDefaultDecl },
      });

      const res = await app.request("/ws-test/variables");
      const body = (await res.json()) as { variables: VariableRow[] };
      expect(body.variables[0]).toMatchObject({
        source: "default",
        value: null,
        effective_value: "fallback@example.com",
        is_filled: true,
      });
    });

    test("source is `unset` when env is absent and no default exists", async () => {
      const dir = getDir();

      const { app } = createTestApp({
        workspacePath: dir,
        variables: { email_recipient: stringDecl },
      });

      const res = await app.request("/ws-test/variables");
      const body = (await res.json()) as { variables: VariableRow[] };
      expect(body.variables[0]).toMatchObject({
        source: "unset",
        value: null,
        effective_value: null,
        is_filled: false,
      });
    });
  });

  // Test case #3 — validation_error populated when env fails schema.
  describe("validation_error", () => {
    const getDir = useTempWorkspaceDir();

    test("populates validation_error when env value fails schema, falls through to unset", async () => {
      const dir = getDir();
      await writeFile(join(dir, ".env"), "THRESHOLD=not-an-integer\n");

      const { app } = createTestApp({ workspacePath: dir, variables: { threshold: integerDecl } });

      const res = await app.request("/ws-test/variables");
      const body = (await res.json()) as { variables: VariableRow[] };
      const row = body.variables[0];
      expect(row?.value).toBe("not-an-integer");
      expect(row?.source).toBe("unset");
      expect(row?.is_filled).toBe(false);
      expect(row?.validation_error).toBeDefined();
    });
  });

  // Test case #4 — authz: 403 non-member, 404 missing workspace.
  describe("authz", () => {
    const getDir = useTempWorkspaceDir();

    test("returns 403 when caller has no membership row", async () => {
      membershipMocks.get.mockResolvedValueOnce({ ok: true, data: null });

      const dir = getDir();
      const { app } = createTestApp({ workspacePath: dir, variables: {} });

      const res = await app.request("/ws-test/variables");
      expect(res.status).toBe(403);
    });

    test("returns 404 when workspace is not registered", async () => {
      const dir = getDir();
      const { app } = createTestApp({ workspacePath: dir, workspaceFound: false });

      const res = await app.request("/ws-test/variables");
      expect(res.status).toBe(404);
      const body = (await res.json()) as JsonBody;
      expect(body).toMatchObject({ success: false, error: "not_found" });
    });
  });
});
