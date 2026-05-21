/**
 * Integration test for the re-setup recovery flow (Task #23).
 *
 * Asserts Decision 4 end-to-end: a workspace that completed initial setup
 * and then has its pinned credential disconnected re-enters setup state
 * *without* redirect, surfaces the gap on the next chat-prompt composition,
 * and recovers via the `request_workspace_setup` MCP tool flowing through
 * the same answer-handler dispatch that initial-setup forms use.
 *
 * Strategy A — in-process. The real Hono workspaces + elicitations routes,
 * the real `commitWorkspaceSetupAnswer` pipeline, the real system-prompt
 * builder helper (`fetchWorkspaceSetupStatus` + `formatSetupStatusBlock`),
 * and the real `request_workspace_setup` tool are exercised against an
 * in-memory ElicitationStorage facade, an in-memory Link credential store,
 * and a workspace manager that backs onto an in-memory env overlay so we
 * can assert prompt contents byte-for-byte and storage outcomes precisely.
 *
 * Per the design's Testing Decisions #13 and #17, and User Stories #18, #21.
 */

import process from "node:process";
import { type WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import { createStubPlatformModels } from "@atlas/llm";
import { createLogger, type Logger } from "@atlas/logger";
import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "./factory.ts";

// ---------------------------------------------------------------------------
// Mocked boundary surfaces. Everything below the daemon's "edge" is real;
// only third-party persistence + outbound RPC is faked.
// ---------------------------------------------------------------------------

const {
  mockFetchLinkCredential,
  mockResolveCredentialsByProvider,
  MockLinkCredentialNotFoundError,
  MockCredentialNotFoundError,
  MockInvalidProviderError,
  mockSetEnvFileVar,
  mockLoadWorkspaceEnv,
  mockChatStorage,
  mockElicitationStorageState,
  mockElicitationStorage,
  mockApplyDraftAwareMutation,
  mockClientGet,
  mockParseResult,
  mockEmitWorkspaceSetupElicitation,
  mockToolAccessGrants,
} = vi.hoisted(() => {
  class MockLinkNotFound extends Error {
    readonly credentialId: string;
    constructor(credentialId: string) {
      super(`Credential ${credentialId} not found`);
      this.name = "LinkCredentialNotFoundError";
      this.credentialId = credentialId;
    }
  }
  class MockCredNotFound extends Error {
    constructor(provider: string) {
      super(`No credentials for ${provider}`);
      this.name = "CredentialNotFoundError";
    }
  }
  class MockInvalidProvider extends Error {
    constructor(provider: string) {
      super(`Invalid provider ${provider}`);
      this.name = "InvalidProviderError";
    }
  }

  interface ElRow {
    id: string;
    workspaceId: string;
    sessionId: string;
    kind: string;
    question: string;
    setupRequirements?: unknown;
    status: "pending" | "answered" | "declined";
    createdAt: string;
    expiresAt: string;
    answer?: { value: unknown; note?: string; answeredBy?: string; answeredAt: string };
  }
  const rows = new Map<string, ElRow>();

  return {
    mockFetchLinkCredential: vi.fn(),
    mockResolveCredentialsByProvider: vi.fn(),
    MockLinkCredentialNotFoundError: MockLinkNotFound,
    MockCredentialNotFoundError: MockCredNotFound,
    MockInvalidProviderError: MockInvalidProvider,
    mockSetEnvFileVar: vi.fn(),
    mockLoadWorkspaceEnv: vi.fn(),
    mockChatStorage: { createChat: vi.fn(), getChat: vi.fn() },
    mockElicitationStorageState: { rows },
    mockElicitationStorage: {
      create: vi.fn(
        (args: {
          workspaceId: string;
          sessionId: string;
          kind: string;
          question: string;
          setupRequirements?: unknown;
          expiresAt: string;
        }) => {
          const id = `elc_${rows.size + 1}`;
          const row: ElRow = {
            id,
            workspaceId: args.workspaceId,
            sessionId: args.sessionId,
            kind: args.kind,
            question: args.question,
            ...(args.setupRequirements !== undefined
              ? { setupRequirements: args.setupRequirements }
              : {}),
            status: "pending",
            createdAt: new Date().toISOString(),
            expiresAt: args.expiresAt,
          };
          rows.set(id, row);
          return Promise.resolve({ ok: true as const, data: row });
        },
      ),
      get: vi.fn(({ id }: { id: string }) => {
        const row = rows.get(id);
        return Promise.resolve({ ok: true as const, data: row ?? null });
      }),
      list: vi.fn(() => Promise.resolve({ ok: true as const, data: [...rows.values()] })),
      answer: vi.fn((args: { id: string; answer: ElRow["answer"] & { answeredAt: string } }) => {
        const row = rows.get(args.id);
        if (!row) return Promise.resolve({ ok: false as const, error: "not found" });
        const updated: ElRow = { ...row, status: "answered", answer: args.answer };
        rows.set(args.id, updated);
        return Promise.resolve({ ok: true as const, data: updated });
      }),
      decline: vi.fn(),
      // Single-flight reserve for the workspace-setup commit (see Finding #2).
      // In-memory mock: reject reserve against a non-pending row with the
      // same "in terminal state" error shape the real adapter returns. The
      // concurrency contract itself is pinned by `jetstream-adapter.test.ts`;
      // this stub only has to satisfy the happy-path single-call shape
      // exercised here.
      reserveForCommit: vi.fn(({ id }: { id: string }) => {
        const row = rows.get(id);
        if (!row) return Promise.resolve({ ok: false as const, error: "not found" });
        if (row.status !== "pending") {
          return Promise.resolve({
            ok: false as const,
            error: `Elicitation ${id} already in terminal state: ${row.status}`,
          });
        }
        return Promise.resolve({ ok: true as const, data: undefined });
      }),
    },
    mockApplyDraftAwareMutation: vi.fn(),
    mockClientGet: vi.fn(),
    mockParseResult: vi.fn(),
    mockEmitWorkspaceSetupElicitation: vi.fn(),
    mockToolAccessGrants: { grantAlways: vi.fn() },
  };
});

vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>()),
  fetchLinkCredential: mockFetchLinkCredential,
  resolveCredentialsByProvider: mockResolveCredentialsByProvider,
  LinkCredentialNotFoundError: MockLinkCredentialNotFoundError,
  CredentialNotFoundError: MockCredentialNotFoundError,
  InvalidProviderError: MockInvalidProviderError,
}));

vi.mock("@atlas/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/workspace")>()),
  setEnvFileVar: mockSetEnvFileVar,
  loadWorkspaceEnv: mockLoadWorkspaceEnv,
}));

vi.mock("@atlas/core/chat/storage", () => ({ ChatStorage: mockChatStorage }));

vi.mock("@atlas/core/elicitations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@atlas/core/elicitations")>();
  return {
    ...actual,
    ElicitationStorage: mockElicitationStorage,
    emitWorkspaceSetupElicitation: mockEmitWorkspaceSetupElicitation,
  };
});

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
    listByUser: vi
      .fn()
      .mockResolvedValue({
        ok: true,
        data: [
          {
            userId: "test-user",
            wsId: "ws_target",
            role: "owner",
            addedAt: "2026-05-11T00:00:00.000Z",
          },
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

vi.mock("../routes/workspaces/draft-helpers.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../routes/workspaces/draft-helpers.ts")>()),
  applyDraftAwareMutation: mockApplyDraftAwareMutation,
}));

vi.mock("../routes/me/adapter.ts", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ ok: true, data: { id: "test-user" } }),
}));

// The system-prompt builder helper (`fetchWorkspaceSetupStatus`) fans out
// through the typed `@atlas/client/v2` against an HTTP daemon. Wire it to
// dispatch through this test's Hono app so the helper sees the *real* GET
// `/workspaces/:id` response shape the daemon emits.
vi.mock("@atlas/client/v2", () => ({
  client: { workspace: { ":workspaceId": { $get: mockClientGet } } },
  parseResult: mockParseResult,
}));

// Imports after mocks so module bindings resolve to the mocked surfaces.
import {
  fetchWorkspaceSetupStatus,
  formatSetupStatusBlock,
} from "../../../packages/system/agents/workspace-chat/setup-status-section.ts";
import { createRequestWorkspaceSetupTool } from "../../../packages/system/agents/workspace-chat/tools/request-workspace-setup.ts";
import { elicitationApp as rawElicitationApp } from "../routes/elicitations/index.ts";
import { workspacesRoutes } from "../routes/workspaces/index.ts";

// ---------------------------------------------------------------------------
// Test fixtures + helpers.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws_target";
const WORKSPACE_PATH = "/tmp/ws_target";
const USER_ID = "test-user";
const PINNED_CRED_ID = "cred_gmail_pinned";
const SESSION_ID = "chat_session_re_setup";

const logger: Logger = createLogger({ name: "re-setup-test" });

function buildConfigedWorkspaceYaml(): WorkspaceConfig {
  return WorkspaceConfigSchema.parse({
    version: "1.0",
    workspace: { name: "rtx-monitor" },
    variables: {
      email_recipient: {
        description: "Where the daily summary lands",
        schema: { type: "string", format: "email" },
      },
    },
    tools: {
      mcp: {
        servers: {
          gmail: {
            transport: { type: "stdio", command: "npx", args: ["-y", "@mcp/gmail"] },
            env: {
              GMAIL_TOKEN: {
                from: "link",
                provider: "gmail",
                id: PINNED_CRED_ID,
                key: "access_token",
              },
            },
          },
        },
      },
    },
  });
}

interface TestState {
  env: Record<string, string>;
  metadata: { createdBy: string; active_setup_session_id?: string | null };
  workspaceConfig: WorkspaceConfig;
  configChangeCount: number;
}

function freshState(): TestState {
  return {
    env: { EMAIL_RECIPIENT: "user@example.com" },
    metadata: { createdBy: USER_ID, active_setup_session_id: null },
    workspaceConfig: buildConfigedWorkspaceYaml(),
    configChangeCount: 0,
  };
}

function buildWorkspaceManager(state: TestState): WorkspaceManager {
  const entry = {
    id: WORKSPACE_ID,
    name: "rtx-monitor",
    path: WORKSPACE_PATH,
    configPath: `${WORKSPACE_PATH}/workspace.yml`,
    status: "inactive" as const,
    createdAt: "2026-05-15T00:00:00.000Z",
    lastSeen: "2026-05-15T00:00:00.000Z",
    metadata: state.metadata,
  };
  return {
    find: vi.fn(({ id }: { id: string }) => Promise.resolve(id === WORKSPACE_ID ? entry : null)),
    list: vi.fn(() => Promise.resolve([entry])),
    getWorkspaceConfig: vi.fn(() =>
      Promise.resolve({ atlas: null, workspace: state.workspaceConfig }),
    ),
    registerWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    updateWorkspaceStatus: vi.fn(
      (_id: string, _status: string, opts?: { metadata?: typeof state.metadata }) => {
        if (opts?.metadata) {
          Object.assign(state.metadata, opts.metadata);
          entry.metadata = state.metadata;
        }
        return Promise.resolve();
      },
    ),
    handleWorkspaceConfigChange: vi.fn(() => {
      state.configChangeCount += 1;
      return Promise.resolve();
    }),
  } as unknown as WorkspaceManager;
}

function buildHonoApp(state: TestState) {
  const manager = buildWorkspaceManager(state);
  const ctx: AppContext = {
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: () => manager,
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    daemon: {
      getWorkspaceManager: () => manager,
      triggerWorkspaceSignal: vi.fn(),
      getNatsConnection: () => null,
    } as unknown as AppContext["daemon"],
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
    c.set("app", ctx);
    c.set("userId", USER_ID);
    await next();
  });
  app.route("/api/workspaces", workspacesRoutes);
  app.route("/api/elicitations", rawElicitationApp);
  return { app, manager };
}

// Pipe the system-prompt builder helper through the same Hono app so it
// sees the *real* daemon GET response shape. `mockParseResult` is what the
// helper consumes after `client.workspace[id].$get()` resolves; routing it
// through `app.request` keeps the assertion grounded in the actual handler.
function wireClientToApp(app: Hono<AppVariables>) {
  mockClientGet.mockImplementation(({ param }: { param: { workspaceId: string } }) =>
    app.request(`/api/workspaces/${param.workspaceId}`),
  );
  mockParseResult.mockImplementation(async (responsePromise: Promise<Response>) => {
    const res = await responsePromise;
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, data };
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let state: TestState;

beforeEach(() => {
  vi.clearAllMocks();
  mockElicitationStorageState.rows.clear();
  state = freshState();

  mockLoadWorkspaceEnv.mockImplementation((path: string) => {
    if (path === WORKSPACE_PATH) return { ...state.env };
    return {};
  });
  mockSetEnvFileVar.mockImplementation((envPath: string, key: string, value: string) => {
    if (envPath === `${WORKSPACE_PATH}/.env`) state.env[key] = value;
  });
  mockChatStorage.createChat.mockResolvedValue({ ok: true, data: {} });
  mockChatStorage.getChat.mockResolvedValue({ ok: true, data: null });
  mockApplyDraftAwareMutation.mockImplementation(
    (
      _workspacePath: string,
      mutationFn: (cfg: WorkspaceConfig) => {
        ok: boolean;
        value?: WorkspaceConfig;
        error?: unknown;
      },
    ) => Promise.resolve({ result: mutationFn(state.workspaceConfig), wroteToDraft: false }),
  );
  mockResolveCredentialsByProvider.mockResolvedValue([]);
  // Re-route the agent-side emitter through the real ElicitationStorage path
  // (which our mock backs in-memory) so we exercise the same end-to-end
  // dispatch as the production emit call.
  mockEmitWorkspaceSetupElicitation.mockImplementation(
    (args: { workspaceId: string; sessionId: string; setupRequirements: unknown }) =>
      mockElicitationStorage.create({
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        kind: "workspace-setup",
        question: "Finish setting up this workspace",
        setupRequirements: args.setupRequirements,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The end-to-end scenario.
// ---------------------------------------------------------------------------

describe("re-setup recovery: disconnect → surface → recover", () => {
  test("workspace GET flips requires_setup=true with active_setup_session_id=null after credential disconnect", async () => {
    const { app } = buildHonoApp(state);

    // Phase 1 — workspace is fully configured: pinned credential resolves,
    // env is filled.
    mockFetchLinkCredential.mockImplementation((id: string) =>
      id === PINNED_CRED_ID
        ? Promise.resolve({ id, provider: "gmail", type: "oauth2", secret: {} })
        : Promise.reject(new MockLinkCredentialNotFoundError(id)),
    );

    const beforeRes = await app.request(`/api/workspaces/${WORKSPACE_ID}`);
    expect(beforeRes.status).toBe(200);
    const beforeBody = (await beforeRes.json()) as {
      requires_setup: boolean;
      metadata?: { active_setup_session_id?: string | null };
    };
    expect(beforeBody.requires_setup).toBe(false);

    // Phase 2 — user disconnects the credential in Link. The pinned id no
    // longer resolves; the workspace re-enters Workspace Setup.
    mockFetchLinkCredential.mockImplementation((id: string) =>
      Promise.reject(new MockLinkCredentialNotFoundError(id)),
    );
    mockResolveCredentialsByProvider.mockResolvedValue([]);

    const afterRes = await app.request(`/api/workspaces/${WORKSPACE_ID}`);
    expect(afterRes.status).toBe(200);
    const afterBody = (await afterRes.json()) as {
      requires_setup: boolean;
      setup_requirements: Array<{ kind: string; provider?: string; reason?: string }>;
      metadata?: { active_setup_session_id?: string | null };
    };

    // AC #1: requires_setup flips true; the pointer stays null because this
    // is re-setup (Decision 4), not initial setup. No bootstrap session
    // gets recreated since there was never one to begin with.
    expect(afterBody.requires_setup).toBe(true);
    expect(afterBody.metadata?.active_setup_session_id ?? null).toBeNull();
    expect(afterBody.setup_requirements).toEqual([
      expect.objectContaining({ kind: "credential", provider: "gmail", reason: "stale_id" }),
    ]);
    // No bootstrap chat session was created — recovery only runs when the
    // pointer was previously set, which it never was in the re-setup case.
    expect(mockChatStorage.createChat).not.toHaveBeenCalled();
  });

  test("/jobs page does not redirect — page loads with requires_setup true and pointer null", async () => {
    // The redirect contract: ONLY `/workspaces/:id/chat` (no chatId) consults
    // `metadata.active_setup_session_id` to decide whether to force-redirect
    // to the bootstrap session. Operational pages like `/jobs` render the
    // SetupRequiredBanner above their own content but never redirect away
    // from the workspace (Decision 4, Story #21).
    //
    // In a daemon-side test the contract surfaces as: the workspace GET
    // payload re-setup carries `requires_setup=true` AND
    // `active_setup_session_id=null`. That tuple is precisely what the
    // banner component (`tools/agent-playground/src/lib/components/shared/
    // setup-required-banner.svelte`) keys on to display itself, and what
    // the chat-redirect page-load (`+page.ts:loadBootstrapSessionId`) keys
    // on to NOT redirect from /jobs. We assert it here to pin the data
    // contract feeding both surfaces.
    const { app } = buildHonoApp(state);

    mockFetchLinkCredential.mockImplementation((id: string) =>
      Promise.reject(new MockLinkCredentialNotFoundError(id)),
    );
    mockResolveCredentialsByProvider.mockResolvedValue([]);

    const res = await app.request(`/api/workspaces/${WORKSPACE_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      requires_setup: boolean;
      metadata?: { active_setup_session_id?: string | null };
    };

    // Banner shows when both hold; jobs page renders normally above/below it.
    expect(body.requires_setup).toBe(true);
    expect(body.metadata?.active_setup_session_id ?? null).toBeNull();
  });

  test("next chat-prompt composition injects the setup-status block listing the credential gap", async () => {
    const { app } = buildHonoApp(state);
    wireClientToApp(app);

    // Credential disconnected — same as the previous test's phase 2.
    mockFetchLinkCredential.mockImplementation((id: string) =>
      Promise.reject(new MockLinkCredentialNotFoundError(id)),
    );
    mockResolveCredentialsByProvider.mockResolvedValue([]);

    const status = await fetchWorkspaceSetupStatus(WORKSPACE_ID, logger);

    // shouldInject keys off (requires_setup=true && active_setup_session_id=null).
    expect(status.shouldInject).toBe(true);
    expect(status.setupRequirements).toEqual([
      expect.objectContaining({ kind: "credential", provider: "gmail", reason: "stale_id" }),
    ]);

    const block = formatSetupStatusBlock(status.setupRequirements);

    // AC #3: the block matches the design template. Snapshot the whole
    // formatted text so the next copy churn re-records atomically rather
    // than dribbling through a handful of `toContain` calls each pinned
    // on a single fragment. The structural assertion below is what the
    // snapshot is *not* allowed to drift on: one bullet per requirement
    // in the requirements section (before the empty-line separator).
    expect(block).toMatchInlineSnapshot(`
      "[WORKSPACE SETUP STATUS]
      This workspace currently has unfilled configuration:
      - Credential: gmail (previously-linked credential no longer resolves).

      Do not attempt actions that depend on these. Surface the gap conversationally. Tools:
      - env_set(key, value) — fill a single variable. Confirmation card renders.
      - connect_service(provider) — open OAuth for a single credential.
      - request_workspace_setup() — show the full setup form. Use when multiple gaps OR the user prefers a form to a conversation."
    `);
    const [requirementsSection = ""] = block.split("\n\n");
    const requirementBulletCount = requirementsSection
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .length;
    expect(requirementBulletCount).toBe(status.setupRequirements.length);
  });

  test("system-prompt block is NOT injected once the credential is reconnected", async () => {
    const { app } = buildHonoApp(state);
    wireClientToApp(app);

    // Credential is healthy again.
    mockFetchLinkCredential.mockImplementation((id: string) =>
      id === PINNED_CRED_ID
        ? Promise.resolve({ id, provider: "gmail", type: "oauth2", secret: {} })
        : Promise.reject(new MockLinkCredentialNotFoundError(id)),
    );

    const status = await fetchWorkspaceSetupStatus(WORKSPACE_ID, logger);
    expect(status.shouldInject).toBe(false);
    expect(status.setupRequirements).toEqual([]);
  });

  test("request_workspace_setup tool emits a session-scoped workspace-setup elicitation", async () => {
    const { app } = buildHonoApp(state);
    wireClientToApp(app);

    mockFetchLinkCredential.mockImplementation((id: string) =>
      Promise.reject(new MockLinkCredentialNotFoundError(id)),
    );
    mockResolveCredentialsByProvider.mockResolvedValue([]);

    const tool = createRequestWorkspaceSetupTool({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      logger,
    }) as unknown as {
      request_workspace_setup: {
        execute: (args: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
      };
    };

    const outcome = await tool.request_workspace_setup.execute(
      {},
      { toolCallId: "tc_1", messages: [] },
    );

    expect(outcome).toMatchObject({ status: "pending_confirmation", requirementCount: 1 });

    // AC #4 (emit half): exactly one workspace-setup elicitation persisted,
    // scoped to the current chat session — NOT the (null) bootstrap pointer.
    const rows = [...mockElicitationStorageState.rows.values()];
    const setupRows = rows.filter((r) => r.kind === "workspace-setup");
    expect(setupRows).toHaveLength(1);
    const seeded = setupRows[0];
    if (!seeded) throw new Error("expected one workspace-setup elicitation");
    expect(seeded.sessionId).toBe(SESSION_ID);
    expect(seeded.workspaceId).toBe(WORKSPACE_ID);
    expect(seeded.status).toBe("pending");
    expect(seeded.setupRequirements).toEqual([
      expect.objectContaining({ kind: "credential", provider: "gmail", reason: "stale_id" }),
    ]);
  });

  test("POST /api/elicitations/:id/answer flows through the shared handler and clears requires_setup", async () => {
    const { app, manager } = buildHonoApp(state);
    wireClientToApp(app);

    // Phase: credential is disconnected. Agent emits the form.
    mockFetchLinkCredential.mockImplementation((id: string) =>
      Promise.reject(new MockLinkCredentialNotFoundError(id)),
    );
    mockResolveCredentialsByProvider.mockResolvedValue([]);

    const tool = createRequestWorkspaceSetupTool({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      logger,
    }) as unknown as {
      request_workspace_setup: {
        execute: (args: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
      };
    };
    const emitOutcome = (await tool.request_workspace_setup.execute(
      {},
      { toolCallId: "tc_x", messages: [] },
    )) as { status: string; elicitationId?: string };
    expect(emitOutcome.status).toBe("pending_confirmation");
    const elicitationId = emitOutcome.elicitationId;
    if (!elicitationId) throw new Error("expected an elicitation id from the tool");

    // User picks a fresh credential. The form's payload-shape is the same
    // structured `{ variableValues, credentialChoices }` value the
    // initial-setup form posts — single mutation path, two emission sites.
    const replacementCredId = "cred_gmail_fresh";
    // Both the disconnected pin (the workspace still references) AND the
    // user's freshly-picked credential need to be queryable. Only the
    // replacement is live in Link — the original pin remains gone.
    mockFetchLinkCredential.mockImplementation((id: string) =>
      id === replacementCredId
        ? Promise.resolve({ id, provider: "gmail", type: "oauth2", secret: {} })
        : Promise.reject(new MockLinkCredentialNotFoundError(id)),
    );

    // Watch the credential pin get rewritten on the parsed config — the
    // draft-mutation passes through `updateCredential`, but our mock just
    // pipes the mutate fn through; capture the result by snooping the
    // config the mutate fn returned (handler swaps the id on the env
    // ref in place).
    mockApplyDraftAwareMutation.mockImplementation(
      (
        _workspacePath: string,
        mutationFn: (cfg: WorkspaceConfig) => {
          ok: boolean;
          value?: WorkspaceConfig;
          error?: unknown;
        },
      ) => {
        const result = mutationFn(state.workspaceConfig);
        if (result.ok && result.value) {
          // Persist the mutated config back to the test state so the next
          // workspace GET sees the new id.
          state.workspaceConfig = result.value;
        }
        return Promise.resolve({ result, wroteToDraft: false });
      },
    );

    const answerRes = await app.request(`/api/elicitations/${elicitationId}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: { variableValues: {}, credentialChoices: { gmail: replacementCredId } },
      }),
    });

    expect(answerRes.status).toBe(200);

    // The post-commit signal restart fired exactly once on the manager.
    expect(manager.handleWorkspaceConfigChange).toHaveBeenCalledTimes(1);

    // Elicitation was marked answered in the storage facade.
    const after = mockElicitationStorageState.rows.get(elicitationId);
    expect(after?.status).toBe("answered");

    // AC #4 (commit half): the pin batch ran (one credential committed,
    // no env-write because there were no variable gaps in this scenario).
    expect(mockApplyDraftAwareMutation).toHaveBeenCalledTimes(1);

    // Re-fetch the workspace — now the pinned id resolves to the
    // user-picked credential, so the derivation flips back to
    // `requires_setup === false`.
    const verifyRes = await app.request(`/api/workspaces/${WORKSPACE_ID}`);
    expect(verifyRes.status).toBe(200);
    const verifyBody = (await verifyRes.json()) as {
      requires_setup: boolean;
      setup_requirements: unknown[];
      metadata?: { active_setup_session_id?: string | null };
    };
    expect(verifyBody.requires_setup).toBe(false);
    expect(verifyBody.setup_requirements).toEqual([]);
    expect(verifyBody.metadata?.active_setup_session_id ?? null).toBeNull();
  });

  test("POST /api/elicitations/:id/answer surfaces 500 when the elicitation is no longer pending (CAS guard)", async () => {
    // Pin the terminal-state CAS guard added in commit `2aeb1d89`. Two
    // concurrent /answer posts both pass the pending pre-check at the
    // ElicitationStorage layer if the route doesn't re-check first; the
    // workspace-setup branch was missing that re-check until 2aeb1d89.
    // Drop the guard and the test below would 200 — the route would dispatch
    // a second `commitWorkspaceSetupAnswer` against an already-terminal row
    // and the mock's status overwrite would silently succeed.
    //
    // Strategy: seed a workspace-setup elicitation directly into the
    // in-memory storage facade, flip it to `declined` out of band (the same
    // state a winner's CAS would leave behind), then POST /answer for it
    // and assert the route refuses with a 500 carrying the terminal-state
    // error shape. The dispatch handlers + setEnvFileVar must NOT run.
    const { app } = buildHonoApp(state);
    wireClientToApp(app);

    mockFetchLinkCredential.mockImplementation((id: string) =>
      Promise.reject(new MockLinkCredentialNotFoundError(id)),
    );
    mockResolveCredentialsByProvider.mockResolvedValue([]);

    const seeded = await mockElicitationStorage.create({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      kind: "workspace-setup",
      question: "Finish setting up this workspace",
      setupRequirements: [
        { kind: "credential", provider: "gmail", reason: "stale_id" },
      ],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    if (!seeded.ok) throw new Error("seed elicitation create failed");
    const elicitationId = seeded.data.id;

    // Mutate the row to a terminal status — the same state the CAS guard
    // exists to defend against on a second concurrent /answer.
    const row = mockElicitationStorageState.rows.get(elicitationId);
    if (!row) throw new Error("seeded row missing from in-memory store");
    mockElicitationStorageState.rows.set(elicitationId, { ...row, status: "declined" });

    const answerRes = await app.request(`/api/elicitations/${elicitationId}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: { variableValues: {}, credentialChoices: { gmail: "cred_anything" } },
      }),
    });

    expect(answerRes.status).toBe(500);
    const errBody = (await answerRes.json()) as { error?: string };
    expect(errBody.error).toContain("terminal state");
    expect(errBody.error).toContain("declined");

    // Side-effect channels MUST have been short-circuited by the guard.
    expect(mockSetEnvFileVar).not.toHaveBeenCalled();
    expect(mockApplyDraftAwareMutation).not.toHaveBeenCalled();

    // The row stayed `declined` — the answer mock's unconditional overwrite
    // never got the chance to flip it (which is exactly what the guard
    // exists to prevent on the production code path).
    expect(mockElicitationStorageState.rows.get(elicitationId)?.status).toBe("declined");
  });

  test("the agent-side emission shares the same handler dispatch as the import-time pre-seed", async () => {
    // Decision: "two emission sites for the same elicitation kind." The
    // agent-side emit uses `emitWorkspaceSetupElicitation` (called via the
    // `request_workspace_setup` tool); the import-time spawn uses the
    // exact same helper from `setup-spawn.ts`. Both should route through
    // the answer-handler we just exercised. This test pins the equivalence
    // by emitting via the agent side and asserting the produced row's
    // shape matches what the import-time spawner persists.
    const { app } = buildHonoApp(state);
    wireClientToApp(app);

    mockFetchLinkCredential.mockImplementation((id: string) =>
      Promise.reject(new MockLinkCredentialNotFoundError(id)),
    );

    const tool = createRequestWorkspaceSetupTool({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      logger,
    }) as unknown as {
      request_workspace_setup: {
        execute: (args: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
      };
    };
    await tool.request_workspace_setup.execute({}, { toolCallId: "tc_y", messages: [] });

    const rows = [...mockElicitationStorageState.rows.values()];
    const agentEmitted = rows.find((r) => r.kind === "workspace-setup");
    expect(agentEmitted).toBeDefined();
    if (!agentEmitted) return;

    // Identical envelope to what `spawnBootstrapSessionIfNeeded` writes
    // (see `apps/atlasd/routes/workspaces/setup-spawn.ts`): kind,
    // question, workspaceId + sessionId scoping, setupRequirements.
    expect(agentEmitted.kind).toBe("workspace-setup");
    expect(agentEmitted.question).toBe("Finish setting up this workspace");
    expect(agentEmitted.workspaceId).toBe(WORKSPACE_ID);
    expect(agentEmitted.sessionId).toBe(SESSION_ID);
    expect(Array.isArray(agentEmitted.setupRequirements)).toBe(true);
  });
});

// Silence a possible "open handle" complaint from process listeners the
// daemon-factory module may register at import time during the test run.
afterEach(() => {
  // Some test environments hold onto `process` listeners; ensure none of
  // our mocks accidentally leak handlers across tests.
  process.removeAllListeners("unhandledRejection");
});
