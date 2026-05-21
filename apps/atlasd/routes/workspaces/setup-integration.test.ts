/**
 * Integration test for the initial workspace-setup flow (Task #22).
 *
 * Pins the contract end-to-end across the ~7 modules that participate in
 * Initial Setup (Decision 1 + Decision 6 + Decision 7):
 *
 *   1. POST /create on a config with an unfilled variable + provider-only
 *      credential → response carries `bootstrapSessionId`, a single pending
 *      `workspace-setup` elicitation lands in storage, `.env` does NOT yet
 *      contain the variable value, and the workspace registers WITHOUT signal
 *      registrars firing (gated per T13).
 *   2. POST /api/elicitations/:id/answer with valid
 *      `{ variableValues, credentialChoices }` → 200, `.env` written with the
 *      submitted value, `workspace.yml` rewritten with the credential pin,
 *      elicitation flips to `answered`, `active_setup_session_id` cleared on
 *      metadata, and the signal registrar's `registerWorkspace` is called
 *      once (the deferred registration from step 1 lands post-commit per
 *      Decision 1).
 *   3. After commit, reload the workspace config + run the declared-variable
 *      interpolator: `{{variables.X}}` resolves to the submitted value, not
 *      the literal placeholder — the same value a cron-triggered session
 *      would read from the same config tree.
 *
 * Strategy: real `WorkspaceManager` + real `ElicitationStorage` + real
 * `ChatStorage` (per-worker NATS test server wired by `vitest.setup.ts`) +
 * real filesystem mutations through the setup-answer handler. The Link client
 * is the only mocked boundary — its real impl would require a Link backend.
 * Env writes, elicitation storage, and signal registrar are all real, so the
 * "at least ONE of those three is real" integration bar is cleared.
 */

import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { MergedConfig } from "@atlas/config";
import {
  ElicitationStorage,
  initElicitationStorage,
  LinkCredentialNotFoundError,
} from "@atlas/core";
import { ChatStorage } from "@atlas/core/chat/storage";
import { createStubPlatformModels } from "@atlas/llm";
import {
  createRegistryStorageMemory,
  interpolateConfig,
  loadWorkspaceEnv,
  resolveDeclaredVariables,
  resolveWorkspaceSetupRequirements,
  WorkspaceManager,
  type WorkspaceSignalRegistrar,
  type WorkspaceVariables,
} from "@atlas/workspace";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { getTestNc } from "../../../../vitest.setup.ts";
import type { AppContext, AppVariables } from "../../src/factory.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted Link credential mocks. The test drives Link's snapshot state by
// flipping these per-scenario:
//   - Pre-submit: `gmail` has two credentials, neither marked default →
//     derivation produces a `no_default` credential requirement.
//   - Submit body picks one id → answer handler calls
//     `fetchLinkCredential(id)` during pre-flight, which must return
//     `{ provider: "gmail" }` for the choice to validate.
// ─────────────────────────────────────────────────────────────────────────────

const { mockResolveByProvider, mockFetchLinkCredential } = vi.hoisted(() => ({
  mockResolveByProvider: vi.fn(),
  mockFetchLinkCredential: vi.fn(),
}));

vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>();
  return {
    ...original,
    resolveCredentialsByProvider: mockResolveByProvider,
    fetchLinkCredential: mockFetchLinkCredential,
  };
});

// `getCurrentUser` underpins authz lookups in the workspace routes. The
// membership mock below admits every (userId, wsId) so a stub user here is
// sufficient.
vi.mock("../me/adapter.ts", () => ({
  getCurrentUser: vi
    .fn()
    .mockResolvedValue({ ok: true, data: { id: "test-user", email: "test@example.com" } }),
}));

vi.mock("@atlas/core/workspace-members/storage", () => ({
  WorkspaceMemberStorage: {
    get: vi
      .fn()
      .mockImplementation((userId: string, wsId: string) =>
        Promise.resolve({
          ok: true,
          data: { userId, wsId, role: "owner", addedAt: "2026-05-15T00:00:00.000Z" },
        }),
      ),
    listByUser: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    listByWorkspace: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    put: vi.fn().mockResolvedValue({ ok: true, data: null }),
    putIfAbsent: vi.fn().mockResolvedValue({ ok: true, data: null }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  },
  ensureWorkspaceMembersKVBucket: vi.fn(),
  initWorkspaceMemberStorage: vi.fn(),
  resetWorkspaceMemberStorageForTests: vi.fn(),
}));

// Import the routes AFTER the mocks so the route module binds to the mocked
// credential resolver.
import { elicitationApp } from "../elicitations/index.ts";
import { workspacesRoutes } from "./index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Per-suite test infrastructure. Reuses the shared NATS server wired by
// `vitest.setup.ts` (JetStream + chat KV bucket + elicitations stream are
// already bootstrapped). We only need to bind `ElicitationStorage` to that
// connection — the shared setup wires every other facade but leaves the
// elicitation adapter unbound by design.
// ─────────────────────────────────────────────────────────────────────────────

let fridayHome: string;
let originalFridayHome: string | undefined;
let originalDenoTest: string | undefined;

beforeAll(async () => {
  initElicitationStorage(getTestNc());

  // realpath resolves the macOS `/var → /private/var` symlink. The manager's
  // home-isolation check compares `entry.path` (post-`Deno.realPath`) against
  // FRIDAY_HOME as a string-prefix; without this the tmp dir comes back as
  // `/var/...` while workspaces resolve to `/private/var/...` and every
  // registered workspace is masked as cross-home (404).
  fridayHome = await realpath(await mkdtemp(join(tmpdir(), "atlas-setup-integration-")));
  await mkdir(join(fridayHome, "workspaces"), { recursive: true });

  originalFridayHome = process.env.FRIDAY_HOME;
  process.env.FRIDAY_HOME = fridayHome;

  // Suppress `manager.initialize()`'s auto-import + default-workspace bootstrap
  // — both reach into ~/.atlas to scan for example workspaces and would fight
  // the per-test temp home.
  originalDenoTest = process.env.DENO_TEST;
  process.env.DENO_TEST = "true";
}, 60_000);

afterAll(async () => {
  if (originalFridayHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalFridayHome;
  if (originalDenoTest === undefined) delete process.env.DENO_TEST;
  else process.env.DENO_TEST = originalDenoTest;
  await rm(fridayHome, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test-app wiring
// ─────────────────────────────────────────────────────────────────────────────

interface TestRig {
  app: Hono<AppVariables>;
  manager: WorkspaceManager;
  registerSpy: ReturnType<typeof vi.fn>;
}

async function makeTestRig(): Promise<TestRig> {
  const registry = await createRegistryStorageMemory();
  const manager = new WorkspaceManager(registry);

  // Real signal registrar (spy). The gate either invokes `registerWorkspace`
  // (when the workspace does NOT require setup) or skips it (when it does).
  // Asserting on this spy verifies the T13 gate pre-submit and the
  // post-commit restart.
  const registerSpy = vi
    .fn<(workspaceId: string, workspacePath: string, config: MergedConfig) => Promise<void>>()
    .mockResolvedValue(undefined);
  const signalRegistrar: WorkspaceSignalRegistrar = {
    registerWorkspace: (id, path, config) => registerSpy(id, path, config),
    unregisterWorkspace: () => Promise.resolve(),
  };

  await manager.initialize([signalRegistrar]);

  // Wire the live setup-required probe so the manager's
  // `registerWithRegistrars` gate kicks in — mirrors the daemon's wire-up in
  // `atlas-daemon.ts` so the test exercises the same control flow rather
  // than a fake.
  const { buildSetupRequirementInputs } = await import("../../src/get-workspace-setup-state.ts");
  manager.setRequiresSetupProbe({
    check: async ({ workspacePath, config }) => {
      const { envSnapshot, linkCredentials } = await buildSetupRequirementInputs(
        workspacePath,
        config.workspace,
      );
      const result = resolveWorkspaceSetupRequirements(
        config.workspace,
        envSnapshot,
        linkCredentials,
        { allowStaleIdRecovery: true },
      );
      return result.requires_setup;
    },
  });

  const mockContext: AppContext = {
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: () => manager,
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    daemon: {
      getWorkspaceManager: () => manager,
      getNatsConnection: () => getTestNc(),
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
    c.set("app", mockContext);
    c.set("userId", "test-user");
    await next();
  });
  app.route("/workspaces", workspacesRoutes);
  app.route("/api/elicitations", elicitationApp);

  return { app, manager, registerSpy };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture: tight workspace config with one unfilled string variable
// (`email_recipient`) referenced from a job prompt, plus one provider-only
// Gmail credential ref. Mirrors the rtx-price-monitor pattern — author
// declares a `variables:` block and references it via
// `{{variables.email_recipient}}` in prose the job-level prompt carries.
// ─────────────────────────────────────────────────────────────────────────────

function fixtureConfigWithUnfilledSetup(): Record<string, unknown> {
  return {
    version: "1.0",
    // The workspace `description` field carries the `{{variables.X}}`
    // placeholder. It's a plain string on the workspace identity block, so
    // schema validation passes without dragging in agent/FSM/job
    // requirements. The interpolation contract under test applies to every
    // string in the parsed config tree, so any reachable string is a valid
    // assertion target — agents and job prompts are just the production
    // call sites, not the contract.
    workspace: {
      name: "Setup Integration Test WS",
      description: "Send a summary to {{variables.email_recipient}} every day.",
    },
    // Explicit `memory.own` keeps the auto-injected DEFAULT_WORKSPACE_MEMORY
    // (which mounts the `user` workspace and would fail validation in this
    // isolated test home) out of the picture.
    memory: { own: [{ name: "notes", type: "short_term", strategy: "narrative" }] },
    variables: {
      email_recipient: {
        description: "Where to send the daily summary",
        schema: { type: "string", minLength: 3 },
      },
    },
    tools: {
      mcp: {
        servers: {
          gmail: {
            transport: { type: "stdio", command: "npx", args: ["-y", "some-gmail-mcp"] },
            env: { GMAIL_ACCESS_TOKEN: { from: "link", provider: "gmail", key: "access_token" } },
          },
        },
      },
    },
  };
}

beforeEach(() => {
  mockResolveByProvider.mockReset();
  mockFetchLinkCredential.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// Spec
// ─────────────────────────────────────────────────────────────────────────────

describe("Initial workspace setup — end-to-end (Task #22)", () => {
  test("import → bootstrap session → form submit → env+credential land → interpolation resolves", {
    timeout: 60_000,
  }, async () => {
    // STEP 0: simulate Link state at import time. The user has two Gmail
    // credentials but neither is marked default — so the provider-only ref
    // surfaces a `no_default` requirement instead of auto-resolving via the
    // import-time `toIdRefs` step.
    const userGmail = {
      id: "cred_gmail_user",
      label: "Eric's Gmail",
      displayName: "Eric Skram",
      userIdentifier: "eric@tempest.team",
      isDefault: false,
    };
    const otherGmail = {
      id: "cred_gmail_other",
      label: "Personal Gmail",
      displayName: "Eric (Personal)",
      userIdentifier: "personal@example.com",
      isDefault: false,
    };
    mockResolveByProvider.mockImplementation((provider: string) => {
      if (provider === "gmail") return Promise.resolve([userGmail, otherGmail]);
      return Promise.reject(new Error(`Unexpected provider lookup: ${provider}`));
    });
    // `fetchLinkCredential` — the per-id check used during pre-flight to
    // confirm the user's submission still resolves to a real credential
    // owned by them.
    mockFetchLinkCredential.mockImplementation((id: string) => {
      if (id === "cred_gmail_user") {
        return Promise.resolve({
          id,
          provider: "gmail",
          label: userGmail.label,
          displayName: userGmail.displayName,
          userIdentifier: userGmail.userIdentifier,
          data: { access_token: "fake-token" },
        });
      }
      return Promise.reject(new LinkCredentialNotFoundError(id));
    });

    const { app, manager, registerSpy } = await makeTestRig();

    // STEP 1: import via POST /create. The route writes workspace.yml +
    // .env, runs `spawnBootstrapSessionIfNeeded`, and returns the bootstrap
    // session id.
    const createResp = await app.request("/workspaces/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: fixtureConfigWithUnfilledSetup() }),
    });

    if (createResp.status !== 201) {
      const txt = await createResp.text();
      throw new Error(`POST /workspaces/create ${createResp.status}: ${txt}`);
    }
    const createBody = (await createResp.json()) as {
      success: boolean;
      workspace: { id: string; path: string };
      bootstrapSessionId?: string;
    };
    expect(createBody.success).toBe(true);
    expect(
      createBody.bootstrapSessionId,
      "create response must include bootstrapSessionId",
    ).toMatch(/^chat_[A-Za-z0-9]{10}$/);
    const workspaceId = createBody.workspace.id;
    const workspacePath = createBody.workspace.path;
    const bootstrapSessionId = createBody.bootstrapSessionId!;

    // STEP 2: workspace metadata pointer landed AND signal registrar was
    // NOT invoked during create (T13 gate held).
    const wsAfterImport = await manager.find({ id: workspaceId });
    expect(wsAfterImport?.metadata?.active_setup_session_id).toBe(bootstrapSessionId);
    const registerCallsForOurWorkspace = registerSpy.mock.calls.filter(
      ([id]) => id === workspaceId,
    );
    expect(
      registerCallsForOurWorkspace,
      "signal registrar must NOT register a setup-required workspace (T13)",
    ).toHaveLength(0);

    // STEP 3: bootstrap session contains exactly one pending workspace-setup
    // elicitation, scoped to that session, carrying both setup requirements.
    const listResult = await ElicitationStorage.list({
      workspaceId,
      sessionId: bootstrapSessionId,
      status: "pending",
    });
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) throw new Error("unreachable");
    const pending = listResult.data.filter((e) => e.kind === "workspace-setup");
    expect(pending).toHaveLength(1);
    const elicitation = pending[0]!;
    expect(elicitation.setupRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "variable",
          name: "email_recipient",
          description: "Where to send the daily summary",
        }),
        expect.objectContaining({ kind: "credential", provider: "gmail", reason: "no_default" }),
      ]),
    );

    // STEP 3b: the bootstrap chat session was actually created in storage —
    // not just the metadata pointer. This is the property the T21 redirect
    // depends on: navigating to /workspaces/:id/chat without a session id
    // looks up the pointer and routes to a chat that exists.
    const bootstrapChat = await ChatStorage.getChat(bootstrapSessionId, workspaceId);
    expect(bootstrapChat.ok).toBe(true);
    if (bootstrapChat.ok) {
      expect(bootstrapChat.data).not.toBeNull();
    }

    // STEP 4: pre-submit, .env should not yet have EMAIL_RECIPIENT.
    const envBefore = loadWorkspaceEnv(workspacePath);
    expect(envBefore.EMAIL_RECIPIENT).toBeUndefined();

    // STEP 5: POST /api/elicitations/:id/answer with the structured
    // workspace-setup payload (Decision 6 shape).
    const submitValue = {
      variableValues: { email_recipient: "alerts@tempest.team" },
      credentialChoices: { gmail: "cred_gmail_user" },
    };
    const answerResp = await app.request(`/api/elicitations/${elicitation.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: submitValue, answeredBy: "test-user" }),
    });
    if (answerResp.status !== 200) {
      const body = await answerResp.text();
      throw new Error(`POST /api/elicitations/:id/answer ${answerResp.status}: ${body}`);
    }

    // STEP 6: .env contains the submitted variable value.
    const envAfter = loadWorkspaceEnv(workspacePath);
    expect(envAfter.EMAIL_RECIPIENT).toBe("alerts@tempest.team");

    // STEP 7: workspace.yml rewritten with the credential pin in place of
    // the provider-only ref. The mutation pipeline writes the chosen id
    // through `updateCredential`.
    const yamlText = await readFile(join(workspacePath, "workspace.yml"), "utf-8");
    expect(yamlText).toContain("cred_gmail_user");

    // STEP 8: elicitation flipped to answered, `active_setup_session_id`
    // cleared on workspace metadata.
    const refetched = await ElicitationStorage.get({ id: elicitation.id });
    expect(refetched.ok).toBe(true);
    if (!refetched.ok || !refetched.data) {
      throw new Error("elicitation went missing after answer");
    }
    expect(refetched.data.status).toBe("answered");

    const wsAfterSubmit = await manager.find({ id: workspaceId });
    expect(
      wsAfterSubmit?.metadata?.active_setup_session_id,
      "active_setup_session_id must clear once initial setup completes",
    ).toBeUndefined();

    // STEP 9: post-commit, `handleWorkspaceConfigChange` re-evaluated the
    // gate (now passing) and the registrar's `registerWorkspace` is called
    // exactly once for our workspace.
    const registerCallsAfterSubmit = registerSpy.mock.calls.filter(([id]) => id === workspaceId);
    expect(
      registerCallsAfterSubmit,
      "signal registrar must register the workspace once setup completes",
    ).toHaveLength(1);

    // STEP 10: reload the config + run declared-variable interpolation
    // against the freshly-written .env. `{{variables.email_recipient}}`
    // resolves to the submitted value — proving the cron path, which reads
    // the same interpolated config tree, will see the resolved value rather
    // than the literal placeholder.
    const reloaded = await manager.getWorkspaceConfig(workspaceId);
    if (!reloaded) throw new Error("workspace config not loadable after setup");
    const declared = resolveDeclaredVariables(
      reloaded.workspace.variables,
      loadWorkspaceEnv(workspacePath),
    );
    const wsVars: WorkspaceVariables = {
      repo_root: workspacePath,
      workspace_path: workspacePath,
      workspace_id: workspaceId,
      platform_url: "http://localhost:8080",
    };
    const interpolatedConfig = interpolateConfig(reloaded.workspace, wsVars, declared);
    const interpolatedDescription = interpolatedConfig.workspace.description;
    expect(interpolatedDescription).toBe("Send a summary to alerts@tempest.team every day.");
    expect(interpolatedDescription).not.toContain("{{variables.email_recipient}}");
  });
});
