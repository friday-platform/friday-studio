/**
 * Tests for the elicitation HTTP routes.
 *
 * The JetStream-backed storage facade (`ElicitationStorage` from
 * `@atlas/core`) is too heavy to spin up in unit tests, so we mock the
 * `@atlas/core/elicitations` module wholesale and assert the routes
 * shape requests/responses correctly + return the right HTTP statuses.
 *
 * Live JetStream coverage lives in the adapter's own `*.test.ts`.
 */

import { fail, success } from "@atlas/utils";
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock for the storage facade
// ---------------------------------------------------------------------------

const { mockElicitationStorage, mockToolAccessGrants } = vi.hoisted(() => ({
  mockElicitationStorage: {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    answer: vi.fn(),
    decline: vi.fn(),
    reserveForCommit: vi.fn(),
  },
  mockToolAccessGrants: { grantAlways: vi.fn() },
}));

vi.mock("@atlas/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@atlas/core")>();
  return {
    ...actual,
    ElicitationStorage: mockElicitationStorage,
    ToolAccessGrants: mockToolAccessGrants,
  };
});

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
    // listByUser drives the per-user accessible-workspaces filter on the
    // global elicitation list. The fixture elicitations are all stamped
    // with `ws_1`, so seed that as an owned workspace so the listing
    // doesn't drop them.
    listByUser: vi
      .fn()
      .mockResolvedValue({
        ok: true,
        data: [
          { userId: "test-user", wsId: "ws_1", role: "owner", addedAt: "2026-05-11T00:00:00.000Z" },
        ],
      }),
    listByWorkspace: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    put: vi.fn().mockResolvedValue({ ok: true, data: null }),
    putIfAbsent: vi.fn().mockResolvedValue({ ok: true, data: null }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  },
  ensureWorkspaceMembersKVBucket: vi.fn(),
  initWorkspaceMemberStorage: vi.fn(),
  resetWorkspaceMemberStorageForTests: vi.fn(),
}));

// `env-write` confirmations route the actual write through these — mock both
// so the `/answer` tests can assert the commit-before-`answer` ordering and
// the failure path without touching the filesystem.
const { mockCommitGlobalEnvWrite, mockSetEnvFileVar } = vi.hoisted(() => ({
  mockCommitGlobalEnvWrite: vi.fn(),
  mockSetEnvFileVar: vi.fn(),
}));

vi.mock("../../src/env-commit.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/env-commit.ts")>()),
  commitGlobalEnvWrite: mockCommitGlobalEnvWrite,
}));

vi.mock("@atlas/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/workspace")>()),
  setEnvFileVar: mockSetEnvFileVar,
}));

// `workspace-setup` confirmations route through the setup-answer-handler.
// Mock the handler at module boundary so the route tests can assert the
// dispatch shape (the 400-on-validation-failure, 500-on-commit-failure, and
// post-commit signal restart paths) without rebuilding the full Link +
// draft-mutation stack inside this test file.
const { mockCommitWorkspaceSetupAnswer } = vi.hoisted(() => ({
  mockCommitWorkspaceSetupAnswer: vi.fn(),
}));

vi.mock("../../src/setup-answer-handler.ts", () => ({
  commitWorkspaceSetupAnswer: mockCommitWorkspaceSetupAnswer,
}));

// Import AFTER the mock so the route binds to the mocked facade.
import { elicitationApp as rawElicitationApp } from "./index.ts";

// ---------------------------------------------------------------------------
// Test app — wires the routes under a Hono app with a mock context.
// We don't exercise `/stream` here (would require a real NATS), so the
// daemon getter never runs.
// ---------------------------------------------------------------------------

interface MockWorkspaceManager {
  find: (q: { id: string }) => Promise<{ id: string; path: string; configPath: string } | null>;
  getWorkspaceConfig: (
    id: string,
  ) => Promise<{ atlas: null; workspace: { version: "1.0"; workspace: { name: string } } } | null>;
  handleWorkspaceConfigChange: (
    workspace: { id: string; path: string; configPath: string },
    filePath: string,
  ) => Promise<void>;
}
type MockContext = {
  daemon: { getNatsConnection: () => null };
  getWorkspaceManager: () => MockWorkspaceManager;
};

function defaultWorkspaceManager(): MockWorkspaceManager {
  return {
    find: ({ id }: { id: string }) =>
      Promise.resolve({ id, path: `/tmp/${id}`, configPath: `/tmp/${id}/workspace.yml` }),
    getWorkspaceConfig: (id: string) =>
      Promise.resolve({ atlas: null, workspace: { version: "1.0", workspace: { name: id } } }),
    handleWorkspaceConfigChange: () => Promise.resolve(),
  };
}

function createTestApp(workspaceManager?: MockWorkspaceManager) {
  const app = new Hono<{ Variables: { app: MockContext; userId?: string } }>();
  app.use("*", async (c, next) => {
    c.set("app", {
      daemon: { getNatsConnection: () => null },
      getWorkspaceManager: () => workspaceManager ?? defaultWorkspaceManager(),
    });
    c.set("userId", "test-user");
    await next();
  });
  app.route("/", rawElicitationApp);
  return app;
}

function makeElicitation(overrides: Record<string, unknown> = {}) {
  return {
    id: "elc_1",
    workspaceId: "ws_1",
    sessionId: "sess_1",
    kind: "open-question" as const,
    question: "Continue?",
    createdAt: "2026-05-05T00:00:00.000Z",
    expiresAt: "2026-05-05T01:00:00.000Z",
    status: "pending" as const,
    ...overrides,
  };
}

beforeEach(() => {
  // `vi.clearAllMocks()` resets call history but does NOT drain
  // `mockResolvedValueOnce` queues. A leftover queued stub from a prior
  // test would silently feed the next one. Explicitly `mockReset()` each
  // hoisted mock fn so the queues come back empty.
  mockElicitationStorage.create.mockReset();
  mockElicitationStorage.get.mockReset();
  mockElicitationStorage.list.mockReset();
  mockElicitationStorage.answer.mockReset();
  mockElicitationStorage.decline.mockReset();
  mockElicitationStorage.reserveForCommit.mockReset();
  // Default: reserve wins. Specific tests override per-call (e.g. concurrent
  // reserve race uses `mockResolvedValueOnce` with `success` then `fail`).
  mockElicitationStorage.reserveForCommit.mockResolvedValue(success(undefined));
  mockToolAccessGrants.grantAlways.mockReset();
  mockCommitGlobalEnvWrite.mockReset();
  mockSetEnvFileVar.mockReset();
  mockCommitWorkspaceSetupAnswer.mockReset();
  mockToolAccessGrants.grantAlways.mockResolvedValue(
    success({
      workspaceId: "ws_1",
      toolName: "send_email",
      scope: "workspace",
      grantedAt: "2026-05-05T00:30:00.000Z",
    }),
  );
});

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------

describe("GET /", () => {
  test("returns empty list when none exist", async () => {
    mockElicitationStorage.list.mockResolvedValueOnce(success([]));
    const res = await createTestApp().request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ elicitations: [], count: 0 });
  });

  test("forwards filter params to the storage facade", async () => {
    mockElicitationStorage.list.mockResolvedValueOnce(success([]));
    await createTestApp().request("/?workspaceId=ws_1&sessionId=sess_1&status=pending");
    expect(mockElicitationStorage.list).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      sessionId: "sess_1",
      status: "pending",
    });
  });

  test("kind filter is applied client-side after storage list", async () => {
    const open = makeElicitation({ id: "elc_open", kind: "open-question" });
    const refresh = makeElicitation({ id: "elc_auth", kind: "auth-refresh" });
    mockElicitationStorage.list.mockResolvedValueOnce(success([open, refresh]));
    const res = await createTestApp().request("/?kind=auth-refresh");
    const body = (await res.json()) as { count: number; elicitations: { id: string }[] };
    expect(body.count).toBe(1);
    expect(body.elicitations[0]?.id).toBe("elc_auth");
  });

  test("rejects an unknown status value (zod validator)", async () => {
    const res = await createTestApp().request("/?status=garbage");
    expect(res.status).toBe(400);
  });

  test("propagates storage errors as 500", async () => {
    mockElicitationStorage.list.mockResolvedValueOnce(fail("kv broken"));
    const res = await createTestApp().request("/");
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------

describe("GET /:id", () => {
  test("returns the elicitation when it exists", async () => {
    const e = makeElicitation();
    mockElicitationStorage.get.mockResolvedValueOnce(success(e));
    const res = await createTestApp().request("/elc_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(e);
  });

  test("404s when not found", async () => {
    mockElicitationStorage.get.mockResolvedValueOnce(success(null));
    const res = await createTestApp().request("/elc_missing");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/answer
// ---------------------------------------------------------------------------

describe("POST /:id/answer", () => {
  test("404s on unknown id", async () => {
    mockElicitationStorage.get.mockResolvedValueOnce(success(null));
    const res = await createTestApp().request("/elc_missing/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "allow-once" }),
    });
    expect(res.status).toBe(404);
    expect(mockElicitationStorage.answer).not.toHaveBeenCalled();
  });

  test("happy path → status flips to answered", async () => {
    const pending = makeElicitation();
    const answered = makeElicitation({
      status: "answered",
      answer: {
        value: "allow-once",
        note: "from web",
        answeredBy: "user@x",
        answeredAt: "2026-05-05T00:30:00.000Z",
      },
    });
    mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
    mockElicitationStorage.answer.mockResolvedValueOnce(success(answered));

    const res = await createTestApp().request("/elc_1/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "allow-once", note: "from web", answeredBy: "user@x" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; answer: { value: string } };
    expect(body.status).toBe("answered");
    expect(body.answer.value).toBe("allow-once");

    // Server should have filled `answeredAt` (ISO string).
    const callArg = mockElicitationStorage.answer.mock.calls[0]?.[0] as
      | { id: string; answer: { answeredAt: string; value: string } }
      | undefined;
    expect(callArg?.answer.answeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(callArg?.answer.value).toBe("allow-once");
  });

  test("allow_always on a tool-allowlist elicitation persists a workspace tool grant", async () => {
    const pending = makeElicitation({
      kind: "tool-allowlist",
      pendingTool: { name: "send_email", args: {} },
    });
    const answered = makeElicitation({
      kind: "tool-allowlist",
      pendingTool: { name: "send_email", args: {} },
      status: "answered",
      answer: {
        value: "allow_always",
        answeredBy: "user@x",
        answeredAt: "2026-05-05T00:30:00.000Z",
      },
    });
    mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
    mockElicitationStorage.answer.mockResolvedValueOnce(success(answered));

    const res = await createTestApp().request("/elc_1/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "allow_always", answeredBy: "user@x" }),
    });

    expect(res.status).toBe(200);
    expect(mockToolAccessGrants.grantAlways).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      toolName: "send_email",
      sourceElicitationId: "elc_1",
      grantedBy: "user@x",
    });
  });

  test("rejects body missing `value`", async () => {
    const res = await createTestApp().request("/elc_1/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "no value field" }),
    });
    expect(res.status).toBe(400);
    expect(mockElicitationStorage.answer).not.toHaveBeenCalled();
  });

  // ── env-write confirmations: the write must land *before* `answer` ──────
  describe("env-write confirmations", () => {
    function envWriteElicitation(
      args: Record<string, unknown>,
      overrides: Record<string, unknown> = {},
    ) {
      return makeElicitation({
        kind: "env-write",
        pendingTool: { name: "env_set", args },
        ...overrides,
      });
    }

    test("global confirm commits the write before marking answered", async () => {
      const pending = envWriteElicitation({ scope: "global", vars: { LOG_LEVEL: "info" } });
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
      mockElicitationStorage.answer.mockResolvedValueOnce(
        success(makeElicitation({ kind: "env-write", status: "answered" })),
      );

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "confirm" }),
      });

      expect(res.status).toBe(200);
      expect(mockCommitGlobalEnvWrite).toHaveBeenCalledWith("LOG_LEVEL", "info");
      // Ordering: the commit's invocation order is strictly before `answer`'s.
      const commitOrder = mockCommitGlobalEnvWrite.mock.invocationCallOrder[0];
      const answerOrder = mockElicitationStorage.answer.mock.invocationCallOrder[0];
      expect(commitOrder).toBeLessThan(answerOrder ?? Infinity);
    });

    test("a failed commit 500s and leaves the elicitation pending (answer not called)", async () => {
      const pending = envWriteElicitation({ scope: "global", vars: { API_URL: "x" } });
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
      mockCommitGlobalEnvWrite.mockImplementationOnce(() => {
        throw new Error("disk full");
      });

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "confirm" }),
      });

      expect(res.status).toBe(500);
      expect(mockElicitationStorage.answer).not.toHaveBeenCalled();
    });

    test.each([
      "answered",
      "expired",
      "declined",
    ] as const)("%s env-write confirm is rejected before committing", async (status) => {
      const terminal = envWriteElicitation(
        { scope: "workspace", vars: { API_KEY: "" } },
        { status },
      );
      mockElicitationStorage.get.mockResolvedValueOnce(success(terminal));

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "confirm", varsOverride: { API_KEY: "stale-secret" } }),
      });

      expect(res.status).toBe(500);
      expect(mockSetEnvFileVar).not.toHaveBeenCalled();
      expect(mockCommitGlobalEnvWrite).not.toHaveBeenCalled();
      expect(mockElicitationStorage.answer).not.toHaveBeenCalled();
    });

    test("workspace confirm writes through setEnvFileVar then marks answered", async () => {
      // Target workspace comes from the elicitation envelope, not the args.
      const pending = envWriteElicitation({ scope: "workspace", vars: { LOG_DIR: "/var/log" } });
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
      mockElicitationStorage.answer.mockResolvedValueOnce(
        success(makeElicitation({ kind: "env-write", status: "answered" })),
      );

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "confirm" }),
      });

      expect(res.status).toBe(200);
      expect(mockSetEnvFileVar).toHaveBeenCalledWith("/tmp/ws_1/.env", "LOG_DIR", "/var/log");
      expect(mockElicitationStorage.answer).toHaveBeenCalled();
    });

    test("workspace confirm ignores an args-supplied workspaceId — envelope wins", async () => {
      // Security boundary: a tampered `pendingTool.args.workspaceId` must not
      // redirect the write. The envelope's `workspaceId` (server-controlled at
      // create time) is authoritative; the stray args key is ignored.
      const pending = makeElicitation({
        kind: "env-write",
        workspaceId: "ws_1",
        pendingTool: {
          name: "env_set",
          args: { scope: "workspace", vars: { LOG_DIR: "/var/log" }, workspaceId: "ws_attacker" },
        },
      });
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
      mockElicitationStorage.answer.mockResolvedValueOnce(
        success(makeElicitation({ kind: "env-write", status: "answered" })),
      );

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "confirm" }),
      });

      expect(res.status).toBe(200);
      expect(mockSetEnvFileVar).toHaveBeenCalledWith("/tmp/ws_1/.env", "LOG_DIR", "/var/log");
      expect(mockSetEnvFileVar).not.toHaveBeenCalledWith(
        "/tmp/ws_attacker/.env",
        expect.anything(),
        expect.anything(),
      );
    });

    test("malformed pendingTool args 500s and does not mark answered", async () => {
      const pending = envWriteElicitation({ not: "a valid env-write payload" });
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "confirm" }),
      });

      expect(res.status).toBe(500);
      expect(mockCommitGlobalEnvWrite).not.toHaveBeenCalled();
      expect(mockElicitationStorage.answer).not.toHaveBeenCalled();
    });

    test("varsOverride replaces the proposed value for matching keys", async () => {
      // Agent proposed an empty placeholder for a secret-looking key; the
      // confirmation card sends the user-typed real value via varsOverride.
      // The real secret never appears in pendingTool.args (chat history),
      // only in the answer payload and the on-disk .env write.
      // Secret contains a `"` so the leak-detection check below has to
      // account for JSON escaping — a naive substring search on the raw
      // value would silently pass even if the secret were serialized.
      const secret = 'real-"secret"-from-card';
      const pending = envWriteElicitation({
        scope: "workspace",
        vars: { BITBUCKET_WEBHOOK_SECRET: "", LOG_DIR: "/var/log" },
      });
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
      mockElicitationStorage.answer.mockResolvedValueOnce(
        success(makeElicitation({ kind: "env-write", status: "answered" })),
      );

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value: "confirm",
          varsOverride: { BITBUCKET_WEBHOOK_SECRET: secret },
        }),
      });

      expect(res.status).toBe(200);
      expect(mockSetEnvFileVar).toHaveBeenCalledWith(
        "/tmp/ws_1/.env",
        "BITBUCKET_WEBHOOK_SECRET",
        secret,
      );
      // Non-overridden key keeps its proposed value.
      expect(mockSetEnvFileVar).toHaveBeenCalledWith("/tmp/ws_1/.env", "LOG_DIR", "/var/log");
      const answerInput = mockElicitationStorage.answer.mock.calls[0]?.[0] as {
        answer: Record<string, unknown>;
      };
      expect(answerInput.answer).toEqual(expect.objectContaining({ value: "confirm" }));
      expect(answerInput.answer).not.toHaveProperty("varsOverride");
      // Defense-in-depth: if a regression slipped the secret onto a
      // different field of the answer envelope, it would surface here in
      // JSON-escaped form (`real-\"secret\"-from-card`). Asserting on
      // that form keeps the check honest regardless of how the value
      // gets serialized.
      const serialized = JSON.stringify(answerInput.answer);
      expect(serialized).not.toContain(JSON.stringify(secret).slice(1, -1));
    });

    test("varsOverride cannot inject a key not in the proposal", async () => {
      const pending = envWriteElicitation({ scope: "workspace", vars: { LOG_DIR: "/var/log" } });
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
      mockElicitationStorage.answer.mockResolvedValueOnce(
        success(makeElicitation({ kind: "env-write", status: "answered" })),
      );

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "confirm", varsOverride: { SMUGGLED_KEY: "x" } }),
      });

      expect(res.status).toBe(200);
      expect(mockSetEnvFileVar).toHaveBeenCalledWith("/tmp/ws_1/.env", "LOG_DIR", "/var/log");
      expect(mockSetEnvFileVar).not.toHaveBeenCalledWith(
        "/tmp/ws_1/.env",
        "SMUGGLED_KEY",
        expect.anything(),
      );
      expect(mockSetEnvFileVar).toHaveBeenCalledTimes(1);
    });

    test("rejects a varsOverride value containing a newline", async () => {
      // Validator runs before the handler — no need to queue a `get` mock,
      // and queuing one would leak into the next test (mockResolvedValueOnce
      // queues survive `vi.clearAllMocks()`).
      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "confirm", varsOverride: { API_KEY: "line1\nline2" } }),
      });

      expect(res.status).toBe(400);
      expect(mockElicitationStorage.get).not.toHaveBeenCalled();
      expect(mockSetEnvFileVar).not.toHaveBeenCalled();
      expect(mockElicitationStorage.answer).not.toHaveBeenCalled();
    });

    test("mixed override: both secret and non-secret keys take the user-typed value", async () => {
      // The card edits every value, so SECRET_TOKEN gets its real value
      // and LOG_DIR can be corrected by the user before confirm.
      const pending = envWriteElicitation({
        scope: "workspace",
        vars: { SECRET_TOKEN: "", LOG_DIR: "/var/log" },
      });
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
      mockElicitationStorage.answer.mockResolvedValueOnce(
        success(makeElicitation({ kind: "env-write", status: "answered" })),
      );

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value: "confirm",
          varsOverride: { SECRET_TOKEN: "real-secret", LOG_DIR: "/srv/log" },
        }),
      });

      expect(res.status).toBe(200);
      expect(mockSetEnvFileVar).toHaveBeenCalledWith(
        "/tmp/ws_1/.env",
        "SECRET_TOKEN",
        "real-secret",
      );
      expect(mockSetEnvFileVar).toHaveBeenCalledWith("/tmp/ws_1/.env", "LOG_DIR", "/srv/log");
      expect(mockSetEnvFileVar).toHaveBeenCalledTimes(2);
    });

    test("varsOverride applies to a non-secret-looking key when its key is in the proposal", async () => {
      // The card edits every proposed value, so the user can correct a typo
      // or fill in a value the agent left blank without round-tripping
      // through chat. Server gate is `Object.hasOwn` on the proposal — the
      // override can change a value but never inject a new key.
      const pending = envWriteElicitation({ scope: "workspace", vars: { LOG_DIR: "/var/log" } });
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
      mockElicitationStorage.answer.mockResolvedValueOnce(
        success(makeElicitation({ kind: "env-write", status: "answered" })),
      );

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "confirm", varsOverride: { LOG_DIR: "/etc/log" } }),
      });

      expect(res.status).toBe(200);
      expect(mockSetEnvFileVar).toHaveBeenCalledWith("/tmp/ws_1/.env", "LOG_DIR", "/etc/log");
      expect(mockSetEnvFileVar).toHaveBeenCalledTimes(1);
    });

    test("rejects a varsOverride key that is not a POSIX identifier", async () => {
      // Schema-layer test — mirrors the newline-value test above. Leading
      // digit fails the key regex; the handler never runs.
      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "confirm", varsOverride: { "1bad": "v" } }),
      });

      expect(res.status).toBe(400);
      expect(mockElicitationStorage.get).not.toHaveBeenCalled();
      expect(mockSetEnvFileVar).not.toHaveBeenCalled();
      expect(mockElicitationStorage.answer).not.toHaveBeenCalled();
    });

    test("deny does not commit any write", async () => {
      const pending = envWriteElicitation({ scope: "global", vars: { LOG_LEVEL: "info" } });
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
      mockElicitationStorage.answer.mockResolvedValueOnce(
        success(makeElicitation({ kind: "env-write", status: "answered" })),
      );

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "deny" }),
      });

      expect(res.status).toBe(200);
      expect(mockCommitGlobalEnvWrite).not.toHaveBeenCalled();
      expect(mockSetEnvFileVar).not.toHaveBeenCalled();
      expect(mockElicitationStorage.answer).toHaveBeenCalled();
    });
  });

  // ── workspace-setup confirmations: pre-flight, commit, then restart ──
  describe("workspace-setup confirmations", () => {
    function setupElicitation() {
      return makeElicitation({ kind: "workspace-setup", question: "Configure workspace" });
    }

    const validBody = {
      value: {
        variableValues: { email_recipient: "user@example.com" },
        credentialChoices: { gmail: "cred_gmail" },
      },
    };

    test("happy path: handler commits, signals restart, elicitation marked answered", async () => {
      const pending = setupElicitation();
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
      mockElicitationStorage.answer.mockResolvedValueOnce(
        success(makeElicitation({ kind: "workspace-setup", status: "answered" })),
      );
      mockCommitWorkspaceSetupAnswer.mockResolvedValueOnce({
        ok: true,
        committedKeys: ["EMAIL_RECIPIENT"],
      });
      const restart = vi.fn().mockResolvedValue(undefined);
      const wm: MockWorkspaceManager = {
        ...defaultWorkspaceManager(),
        handleWorkspaceConfigChange: restart,
      };

      const res = await createTestApp(wm).request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);
      expect(mockCommitWorkspaceSetupAnswer).toHaveBeenCalledTimes(1);
      // Ordering: handler runs strictly before `answer`.
      const commitOrder = mockCommitWorkspaceSetupAnswer.mock.invocationCallOrder[0] ?? Infinity;
      const answerOrder = mockElicitationStorage.answer.mock.invocationCallOrder[0] ?? Infinity;
      expect(commitOrder).toBeLessThan(answerOrder);
      // Signals restart after commit.
      expect(restart).toHaveBeenCalledTimes(1);
    });

    test("pre-flight validation failure 400s with per-field errors and skips `answer`", async () => {
      const pending = setupElicitation();
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
      mockCommitWorkspaceSetupAnswer.mockResolvedValueOnce({
        ok: false,
        status: 400,
        errors: { variables: { email_recipient: "Invalid email" }, credentials: {} },
      });

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; variables: Record<string, string> };
      expect(body.error).toBe("validation_failed");
      expect(body.variables.email_recipient).toBe("Invalid email");
      expect(mockElicitationStorage.answer).not.toHaveBeenCalled();
    });

    test("post-pre-flight commit failure 500s with the committed-keys list, leaves elicitation pending", async () => {
      const pending = setupElicitation();
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
      mockCommitWorkspaceSetupAnswer.mockResolvedValueOnce({
        ok: false,
        status: 500,
        message: "credential pin failed: not_found",
        committedKeys: ["EMAIL_RECIPIENT"],
      });

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string; committedKeys: string[] };
      expect(body.committedKeys).toEqual(["EMAIL_RECIPIENT"]);
      expect(body.error).toContain("credential pin failed");
      expect(mockElicitationStorage.answer).not.toHaveBeenCalled();
    });

    test("returns 500 when the workspace is gone before commit", async () => {
      const pending = setupElicitation();
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
      const wm: MockWorkspaceManager = {
        ...defaultWorkspaceManager(),
        find: () => Promise.resolve(null),
      };

      const res = await createTestApp(wm).request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(500);
      expect(mockCommitWorkspaceSetupAnswer).not.toHaveBeenCalled();
      expect(mockElicitationStorage.answer).not.toHaveBeenCalled();
    });

    test("a signal-restart hiccup does NOT block marking the elicitation answered", async () => {
      const pending = setupElicitation();
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
      mockElicitationStorage.answer.mockResolvedValueOnce(
        success(makeElicitation({ kind: "workspace-setup", status: "answered" })),
      );
      mockCommitWorkspaceSetupAnswer.mockResolvedValueOnce({
        ok: true,
        committedKeys: ["EMAIL_RECIPIENT"],
      });
      const wm: MockWorkspaceManager = {
        ...defaultWorkspaceManager(),
        handleWorkspaceConfigChange: () => Promise.reject(new Error("registrar offline")),
      };

      const res = await createTestApp(wm).request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);
      expect(mockElicitationStorage.answer).toHaveBeenCalled();
    });

    test("rejects a malformed workspace-setup value with 400 before dispatching to the handler", async () => {
      const pending = setupElicitation();
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "not-a-structured-payload" }),
      });

      expect(res.status).toBe(400);
      expect(mockCommitWorkspaceSetupAnswer).not.toHaveBeenCalled();
      expect(mockElicitationStorage.answer).not.toHaveBeenCalled();
    });

    test.each([
      "answered",
      "expired",
      "declined",
    ] as const)("%s workspace-setup answer is rejected before committing", async (status) => {
      const terminal = makeElicitation({ kind: "workspace-setup", status });
      mockElicitationStorage.get.mockResolvedValueOnce(success(terminal));

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(500);
      expect(mockCommitWorkspaceSetupAnswer).not.toHaveBeenCalled();
      expect(mockElicitationStorage.answer).not.toHaveBeenCalled();
    });

    // Two concurrent /answer posts both pass the pending pre-check; without
    // the CAS reserve step they'd both call `commitWorkspaceSetupAnswer` →
    // both `setEnvFileVar` and both run the credential-pin draft mutation on
    // workspace.yml. `reserveForCommit` is the single-flight gate: exactly
    // one caller wins, the loser gets 409 and the disk-mutating commit runs
    // exactly once.
    test("concurrent /answer posts: exactly one wins, the other 409s; commit runs once", async () => {
      const pending = setupElicitation();
      // Both requests read the same `pending` snapshot.
      mockElicitationStorage.get.mockResolvedValue(success(pending));
      mockElicitationStorage.answer.mockResolvedValue(
        success(makeElicitation({ kind: "workspace-setup", status: "answered" })),
      );
      mockCommitWorkspaceSetupAnswer.mockResolvedValue({
        ok: true,
        committedKeys: ["EMAIL_RECIPIENT"],
      });
      // First reserve wins; second loses with a clear conflict error.
      mockElicitationStorage.reserveForCommit
        .mockResolvedValueOnce(success(undefined))
        .mockResolvedValueOnce(fail("Elicitation elc_1 commit already in progress"));

      const app = createTestApp();
      const post = () =>
        app.request("/elc_1/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validBody),
        });
      const [a, b] = await Promise.all([post(), post()]);
      const statuses = [a.status, b.status].sort();

      expect(statuses).toEqual([200, 409]);
      // The disk-mutating commit must have run exactly once.
      expect(mockCommitWorkspaceSetupAnswer).toHaveBeenCalledTimes(1);
      // `answer` (the final `pending → answered` CAS flip) only runs for the winner.
      expect(mockElicitationStorage.answer).toHaveBeenCalledTimes(1);
      // Both callers attempted to reserve.
      expect(mockElicitationStorage.reserveForCommit).toHaveBeenCalledTimes(2);
    });

    test("reserveForCommit failure with non-`in progress` reason still 409s (reserve owns the gate)", async () => {
      // The route trusts reserveForCommit's verdict: any failed reserve
      // closes the door. The adapter's pending-pre-check inside reserve
      // can fail for "already terminal" too, and the route surfaces those
      // as 409 (commit-conflict) — semantically the same "you cannot
      // commit right now" verdict.
      const pending = setupElicitation();
      mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
      mockElicitationStorage.reserveForCommit.mockResolvedValueOnce(
        fail("Elicitation elc_1 already in terminal state: answered"),
      );

      const res = await createTestApp().request("/elc_1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(409);
      expect(mockCommitWorkspaceSetupAnswer).not.toHaveBeenCalled();
      expect(mockElicitationStorage.answer).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// POST /:id/decline
// ---------------------------------------------------------------------------

describe("POST /:id/decline", () => {
  test("404s on unknown id", async () => {
    mockElicitationStorage.get.mockResolvedValueOnce(success(null));
    const res = await createTestApp().request("/elc_missing/decline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(mockElicitationStorage.decline).not.toHaveBeenCalled();
  });

  test("happy path → status flips to declined", async () => {
    const pending = makeElicitation();
    const declined = makeElicitation({
      status: "declined",
      answer: { value: "declined", note: "user said no", answeredAt: "2026-05-05T00:30:00.000Z" },
    });
    mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
    mockElicitationStorage.decline.mockResolvedValueOnce(success(declined));

    const res = await createTestApp().request("/elc_1/decline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "user said no" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("declined");
    expect(mockElicitationStorage.decline).toHaveBeenCalledWith({
      id: "elc_1",
      note: "user said no",
    });
  });

  test("works without a note", async () => {
    const pending = makeElicitation();
    const declined = makeElicitation({
      status: "declined",
      answer: { value: "declined", answeredAt: "2026-05-05T00:30:00.000Z" },
    });
    mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
    mockElicitationStorage.decline.mockResolvedValueOnce(success(declined));

    const res = await createTestApp().request("/elc_1/decline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(mockElicitationStorage.decline).toHaveBeenCalledWith({ id: "elc_1" });
  });

  test("rejects a non-string note", async () => {
    const res = await createTestApp().request("/elc_1/decline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: 42 }),
    });
    expect(res.status).toBe(400);
  });
});
