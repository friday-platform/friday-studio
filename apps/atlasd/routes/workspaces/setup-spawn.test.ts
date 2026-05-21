/**
 * Tests for the import-time bootstrap setup spawn (T11).
 *
 * Mocks `ChatStorage`, `ElicitationStorage`, and `assembleLinkCredentialState`
 * so we can drive the helper through its three observable outcomes:
 *   1. `requires_setup === false` → no chat, no elicitation, no metadata write.
 *   2. `requires_setup === true` → one chat, one elicitation, metadata updated,
 *      bootstrap session id returned.
 *   3. Stale pinned credential id → `StaleCredentialIdAtImportError` thrown.
 *
 * The derivation itself (variable filled / not filled, credential resolved /
 * unresolved) is covered by `@atlas/workspace`'s own tests — we only assert
 * the spawn side-effects here.
 */

import { type WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import type { WorkspaceEntry, WorkspaceManager } from "@atlas/workspace";
import { StaleCredentialIdAtImportError } from "@atlas/workspace";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockChatStorage, mockElicitationStorage, mockAssembleLinkState, mockLoadEnv } = vi.hoisted(
  () => ({
    mockChatStorage: {
      createChat: vi.fn(),
      getChat: vi.fn(),
      appendMessage: vi.fn(),
      updateChatTitle: vi.fn(),
    },
    mockElicitationStorage: { create: vi.fn() },
    mockAssembleLinkState: vi.fn(),
    mockLoadEnv: vi.fn(),
  }),
);

vi.mock("@atlas/core/chat/storage", () => ({ ChatStorage: mockChatStorage }));
vi.mock("@atlas/core/elicitations", async (importOriginal) => {
  const original = await importOriginal<typeof import("@atlas/core/elicitations")>();
  return { ...original, ElicitationStorage: mockElicitationStorage };
});
vi.mock("../../src/assemble-link-credential-state.ts", () => ({
  assembleLinkCredentialState: mockAssembleLinkState,
}));
vi.mock("@atlas/workspace", async (importOriginal) => {
  const original = await importOriginal<typeof import("@atlas/workspace")>();
  return { ...original, loadWorkspaceEnv: mockLoadEnv };
});

import { recoverBootstrapSessionIfDeleted, spawnBootstrapSessionIfNeeded } from "./setup-spawn.ts";

function makeWorkspaceEntry(overrides: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    id: "ws-test",
    name: "Test",
    path: "/tmp/ws-test",
    configPath: "/tmp/ws-test/workspace.yml",
    status: "inactive" as const,
    createdAt: "2026-05-15T00:00:00.000Z",
    lastSeen: "2026-05-15T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function makeManager(entry: WorkspaceEntry): {
  manager: WorkspaceManager;
  find: ReturnType<typeof vi.fn>;
  updateWorkspaceStatus: ReturnType<typeof vi.fn>;
} {
  const find = vi.fn().mockResolvedValue(entry);
  const updateWorkspaceStatus = vi.fn().mockResolvedValue(undefined);
  return {
    manager: { find, updateWorkspaceStatus } as unknown as WorkspaceManager,
    find,
    updateWorkspaceStatus,
  };
}

function parseConfig(input: unknown): WorkspaceConfig {
  return WorkspaceConfigSchema.parse(input);
}

function configWithDeclaredVariable(): WorkspaceConfig {
  return parseConfig({
    version: "1.0",
    workspace: { name: "Test" },
    variables: { region: { description: "AWS region", schema: { type: "string" } } },
  });
}

function configWithPinnedCredential(credentialId: string, provider: string): WorkspaceConfig {
  return parseConfig({
    version: "1.0",
    workspace: { name: "Test" },
    tools: {
      mcp: {
        servers: {
          gmail: {
            transport: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/gmail"],
            },
            env: { TOKEN: { from: "link", id: credentialId, provider, key: "access_token" } },
          },
        },
      },
    },
  });
}

function configWithProviderOnly(provider: string): WorkspaceConfig {
  return parseConfig({
    version: "1.0",
    workspace: { name: "Test" },
    tools: {
      mcp: {
        servers: {
          gmail: {
            transport: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/gmail"],
            },
            env: { TOKEN: { from: "link", provider, key: "access_token" } },
          },
        },
      },
    },
  });
}

function configWithNoRequirements(): WorkspaceConfig {
  return parseConfig({ version: "1.0", workspace: { name: "Test" } });
}

describe("spawnBootstrapSessionIfNeeded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChatStorage.createChat.mockResolvedValue({ ok: true, data: {} });
    mockChatStorage.appendMessage.mockResolvedValue({ ok: true });
    mockChatStorage.updateChatTitle.mockResolvedValue({ ok: true, data: {} });
    mockElicitationStorage.create.mockResolvedValue({ ok: true, data: { id: "elic_stub_id" } });
    mockLoadEnv.mockReturnValue({});
    mockAssembleLinkState.mockResolvedValue({
      defaultByProvider: {},
      resolvedIds: new Set<string>(),
      providerErrors: new Set<string>(),
    });
  });

  test("requires_setup === false → no chat, no elicitation, no metadata write", async () => {
    const entry = makeWorkspaceEntry();
    const { manager, updateWorkspaceStatus } = makeManager(entry);

    const result = await spawnBootstrapSessionIfNeeded({
      manager,
      workspaceId: entry.id,
      workspacePath: entry.path,
      parsedConfig: configWithNoRequirements(),
      userId: "user-1",
      existingMetadata: entry.metadata,
    });

    expect(result.requires_setup).toBe(false);
    expect(result.bootstrap_session_id).toBeUndefined();
    expect(mockChatStorage.createChat).not.toHaveBeenCalled();
    expect(mockElicitationStorage.create).not.toHaveBeenCalled();
    expect(updateWorkspaceStatus).not.toHaveBeenCalled();
  });

  test("requires_setup === true → spawns chat + elicitation + writes active_setup_session_id", async () => {
    const entry = makeWorkspaceEntry({ metadata: { createdBy: "user-1" } });
    const { manager, updateWorkspaceStatus } = makeManager(entry);

    const result = await spawnBootstrapSessionIfNeeded({
      manager,
      workspaceId: entry.id,
      workspacePath: entry.path,
      parsedConfig: configWithDeclaredVariable(),
      userId: "user-1",
      existingMetadata: entry.metadata,
    });

    expect(result.requires_setup).toBe(true);
    expect(result.bootstrap_session_id).toMatch(/^chat_[A-Za-z0-9]{10}$/);
    expect(result.setup_requirements).toEqual([
      { kind: "variable", name: "region", description: "AWS region", schema: { type: "string" } },
    ]);

    // Exactly one chat, one welcome message, exactly one elicitation, all scoped to the same id.
    expect(mockChatStorage.createChat).toHaveBeenCalledTimes(1);
    expect(mockChatStorage.appendMessage).toHaveBeenCalledTimes(1);
    expect(mockElicitationStorage.create).toHaveBeenCalledTimes(1);

    // The welcome message is a synthetic assistant turn: a text bubble
    // followed by a completed `request_workspace_setup` tool call whose
    // output carries the elicitation id. `tool-call-card.svelte`
    // dispatches by tool name to render the setup form inline — the
    // same path env-write uses. The elicitation is created BEFORE the
    // message so its id can be embedded in the tool output.
    const elicitationOrder = mockElicitationStorage.create.mock.invocationCallOrder[0] ?? 0;
    const appendOrder = mockChatStorage.appendMessage.mock.invocationCallOrder[0] ?? 0;
    expect(appendOrder).toBeGreaterThan(elicitationOrder);

    const [welcomeChatId, welcomeMessage] = mockChatStorage.appendMessage.mock.calls[0] ?? [];
    expect(welcomeChatId).toBe(result.bootstrap_session_id);
    expect(welcomeMessage).toMatchObject({
      role: "assistant",
      // `metadata.synthetic === true` flags this message as a server-side
      // UI seed that never came from an LLM/agent turn. The workspace-chat
      // agent's history sanitizer drops messages with this flag before
      // calling the LLM so the fabricated `tool-request_workspace_setup`
      // part never enters model history (it would otherwise let the model
      // treat the fake `pending_confirmation` output as real prior work).
      // UI rendering ignores the flag — `tool-call-card.svelte` dispatches
      // on part `type` alone, so the setup form still renders.
      metadata: { synthetic: true },
      parts: [
        { type: "text", text: expect.stringContaining("Welcome to **Test**") },
        {
          type: "tool-request_workspace_setup",
          state: "output-available",
          output: { elicitationId: "elic_stub_id", status: "pending_confirmation" },
        },
      ],
    });

    const chatArgs = mockChatStorage.createChat.mock.calls[0]?.[0];
    expect(chatArgs).toMatchObject({
      chatId: result.bootstrap_session_id,
      userId: "user-1",
      workspaceId: entry.id,
      source: "atlas",
    });

    // Bootstrap chats get a stable "Getting started" title at creation. The
    // workspace-chat agent's auto-title only fires at message counts 2/4,
    // and bootstrap chats start at 1 (synthetic assistant) so counts go
    // 3 → 5 → 7 and never trigger an overwrite.
    expect(mockChatStorage.updateChatTitle).toHaveBeenCalledWith(
      result.bootstrap_session_id,
      "Getting started",
      entry.id,
    );

    const elicitationArgs = mockElicitationStorage.create.mock.calls[0]?.[0];
    expect(elicitationArgs).toMatchObject({
      workspaceId: entry.id,
      sessionId: result.bootstrap_session_id,
      kind: "workspace-setup",
      setupRequirements: result.setup_requirements,
    });

    // active_setup_session_id persisted; createdBy preserved.
    expect(updateWorkspaceStatus).toHaveBeenCalledWith(entry.id, entry.status, {
      metadata: { createdBy: "user-1", active_setup_session_id: result.bootstrap_session_id },
    });
  });

  test("stale pinned credential id (post-import) throws StaleCredentialIdAtImportError", async () => {
    const entry = makeWorkspaceEntry();
    const { manager, updateWorkspaceStatus } = makeManager(entry);

    // Link snapshot says: this id is NOT in `resolvedIds` → derivation throws
    // because `allowStaleIdRecovery: false`.
    mockAssembleLinkState.mockResolvedValueOnce({
      defaultByProvider: {},
      resolvedIds: new Set<string>(),
      providerErrors: new Set<string>(),
    });

    await expect(
      spawnBootstrapSessionIfNeeded({
        manager,
        workspaceId: entry.id,
        workspacePath: entry.path,
        parsedConfig: configWithPinnedCredential("cred_stale", "gmail"),
        userId: "user-1",
        existingMetadata: entry.metadata,
      }),
    ).rejects.toBeInstanceOf(StaleCredentialIdAtImportError);

    // Nothing should be spawned on the failure path.
    expect(mockChatStorage.createChat).not.toHaveBeenCalled();
    expect(mockElicitationStorage.create).not.toHaveBeenCalled();
    expect(updateWorkspaceStatus).not.toHaveBeenCalled();
  });

  test("provider-only ref with no default → spawns and emits credential requirement", async () => {
    const entry = makeWorkspaceEntry();
    const { manager } = makeManager(entry);

    // No credentials configured for the provider → derivation surfaces a
    // `no_default` requirement.
    mockAssembleLinkState.mockResolvedValueOnce({
      defaultByProvider: {},
      resolvedIds: new Set<string>(),
      providerErrors: new Set<string>(),
    });

    const result = await spawnBootstrapSessionIfNeeded({
      manager,
      workspaceId: entry.id,
      workspacePath: entry.path,
      parsedConfig: configWithProviderOnly("gmail"),
      userId: "user-1",
      existingMetadata: entry.metadata,
    });

    expect(result.requires_setup).toBe(true);
    expect(result.setup_requirements).toEqual([
      expect.objectContaining({ kind: "credential", provider: "gmail", reason: "no_default" }),
    ]);
    expect(mockChatStorage.createChat).toHaveBeenCalledTimes(1);
    expect(mockElicitationStorage.create).toHaveBeenCalledTimes(1);
  });

  test("mid-spawn elicitation failure leaves pointer set so next read recovers cleanly", async () => {
    // Regression: previously the pointer was the LAST write, so a throw mid-spawn
    // left the workspace with `requires_setup=true` AND
    // `active_setup_session_id=null`. `recoverBootstrapSessionIfDeleted`
    // short-circuits on a null pointer, making the orphan unrecoverable.
    // Writing the pointer FIRST hands recovery a session id it can re-seed.
    const entry = makeWorkspaceEntry({ metadata: { createdBy: "user-1" } });
    const { manager, updateWorkspaceStatus } = makeManager(entry);

    // The contract is "no observer can see a non-null pointer without
    // a corresponding chat"; in the mid-spawn-failure case we need the
    // INVERSE: when the elicitation create runs (whether it succeeds or
    // fails), the metadata pointer must already be populated so a
    // subsequent recovery read can find it. Snapshot the pointer state
    // visible to `updateWorkspaceStatus` AT the moment the failing
    // elicitation create fires — proves the invariant without relying
    // on `invocationCallOrder` (a brittle proxy: a future await between
    // them passes the order check but still breaks the invariant).
    let pointerAtFailingElicitationCall: string | undefined;
    mockElicitationStorage.create.mockImplementationOnce(() => {
      const lastUpdate = updateWorkspaceStatus.mock.calls.at(-1);
      pointerAtFailingElicitationCall = lastUpdate?.[2]?.metadata?.active_setup_session_id;
      return { ok: false, error: "kv down" };
    });

    await expect(
      spawnBootstrapSessionIfNeeded({
        manager,
        workspaceId: entry.id,
        workspacePath: entry.path,
        parsedConfig: configWithDeclaredVariable(),
        userId: "user-1",
        existingMetadata: entry.metadata,
      }),
    ).rejects.toThrow(/Failed to create bootstrap elicitation: kv down/);

    // Pointer was flipped BEFORE the failing elicitation create.
    expect(updateWorkspaceStatus).toHaveBeenCalledTimes(1);
    const writtenMetadata = updateWorkspaceStatus.mock.calls[0]?.[2]?.metadata;
    expect(writtenMetadata?.active_setup_session_id).toMatch(/^chat_[A-Za-z0-9]{10}$/);
    expect(writtenMetadata?.createdBy).toBe("user-1");
    const orphanSessionId = writtenMetadata?.active_setup_session_id as string;

    // Contract pin: observed inside the failing elicitation create —
    // the pointer was already populated by the time the elicitation
    // call ran. This breaks if a future refactor moves the metadata
    // write back after the elicitation create, even if no `await`
    // separates them.
    expect(pointerAtFailingElicitationCall).toBe(orphanSessionId);

    // Recovery sees the pointer + a missing chat and re-seeds the session.
    mockChatStorage.createChat.mockClear();
    mockElicitationStorage.create.mockClear();
    mockChatStorage.appendMessage.mockClear();
    updateWorkspaceStatus.mockClear();
    mockChatStorage.getChat.mockResolvedValueOnce({ ok: true, data: null });

    const recovered = await recoverBootstrapSessionIfDeleted({
      manager,
      workspace: makeWorkspaceEntry({
        metadata: { createdBy: "user-1", active_setup_session_id: orphanSessionId },
      }),
      parsedConfig: configWithDeclaredVariable(),
      setupRequirements: [
        {
          kind: "variable" as const,
          name: "region",
          description: "AWS region",
          schema: { type: "string" as const },
        },
      ],
      userId: "user-1",
    });

    expect(recovered.recovered).toBe(true);
    expect(recovered.bootstrap_session_id).toMatch(/^chat_[A-Za-z0-9]{10}$/);
    expect(mockChatStorage.createChat).toHaveBeenCalledTimes(1);
    expect(mockElicitationStorage.create).toHaveBeenCalledTimes(1);
    expect(updateWorkspaceStatus).toHaveBeenCalledTimes(1);
  });

  test("merges existing metadata (preserves color, createdBy) when writing active_setup_session_id", async () => {
    const entry = makeWorkspaceEntry({
      metadata: { createdBy: "user-1", color: "blue", description: "an existing workspace" },
    });
    const { manager, updateWorkspaceStatus } = makeManager(entry);

    await spawnBootstrapSessionIfNeeded({
      manager,
      workspaceId: entry.id,
      workspacePath: entry.path,
      parsedConfig: configWithDeclaredVariable(),
      userId: "user-1",
      existingMetadata: entry.metadata,
    });

    const writtenMetadata = updateWorkspaceStatus.mock.calls[0]?.[2]?.metadata;
    expect(writtenMetadata).toMatchObject({
      createdBy: "user-1",
      color: "blue",
      description: "an existing workspace",
    });
    expect(writtenMetadata?.active_setup_session_id).toMatch(/^chat_[A-Za-z0-9]{10}$/);
  });
});

describe("recoverBootstrapSessionIfDeleted", () => {
  const setupRequirements = [
    {
      kind: "variable" as const,
      name: "region",
      description: "AWS region",
      schema: { type: "string" as const },
    },
  ];
  const parsedConfig: WorkspaceConfig = parseConfig({
    version: "1.0",
    workspace: { name: "Test" },
    variables: { region: { description: "AWS region", schema: { type: "string" } } },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockChatStorage.createChat.mockResolvedValue({ ok: true, data: {} });
    mockChatStorage.appendMessage.mockResolvedValue({ ok: true });
    mockChatStorage.updateChatTitle.mockResolvedValue({ ok: true, data: {} });
    mockElicitationStorage.create.mockResolvedValue({ ok: true, data: { id: "elic_stub_id" } });
  });

  test("session deleted → re-creates chat, re-seeds elicitation, updates pointer atomically", async () => {
    const previousSessionId = "11111111-1111-1111-1111-111111111111";
    const entry = makeWorkspaceEntry({
      metadata: { createdBy: "user-1", active_setup_session_id: previousSessionId },
    });
    const { manager, updateWorkspaceStatus } = makeManager(entry);
    mockChatStorage.getChat.mockResolvedValueOnce({ ok: true, data: null });

    const result = await recoverBootstrapSessionIfDeleted({
      manager,
      workspace: entry,
      parsedConfig,
      setupRequirements,
      userId: "user-1",
    });

    expect(result.recovered).toBe(true);
    expect(result.bootstrap_session_id).toMatch(/^chat_[A-Za-z0-9]{10}$/);
    expect(result.bootstrap_session_id).not.toBe(previousSessionId);

    expect(mockChatStorage.getChat).toHaveBeenCalledWith(previousSessionId, entry.id);
    expect(mockChatStorage.createChat).toHaveBeenCalledTimes(1);
    expect(mockChatStorage.createChat).toHaveBeenCalledWith({
      chatId: result.bootstrap_session_id,
      userId: "user-1",
      workspaceId: entry.id,
      source: "atlas",
    });
    expect(mockElicitationStorage.create).toHaveBeenCalledTimes(1);
    expect(mockElicitationStorage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: entry.id,
        sessionId: result.bootstrap_session_id,
        kind: "workspace-setup",
        setupRequirements,
      }),
    );

    // Pointer write happens after both creates succeed and preserves other metadata.
    expect(updateWorkspaceStatus).toHaveBeenCalledTimes(1);
    expect(updateWorkspaceStatus).toHaveBeenCalledWith(entry.id, entry.status, {
      metadata: { createdBy: "user-1", active_setup_session_id: result.bootstrap_session_id },
    });
    const createOrder = mockChatStorage.createChat.mock.invocationCallOrder[0] ?? 0;
    const elicitationOrder = mockElicitationStorage.create.mock.invocationCallOrder[0] ?? 0;
    const updateOrder = updateWorkspaceStatus.mock.invocationCallOrder[0] ?? 0;
    expect(updateOrder).toBeGreaterThan(createOrder);
    expect(updateOrder).toBeGreaterThan(elicitationOrder);
  });

  test("pointer still valid → no re-spawn, no metadata write", async () => {
    const sessionId = "22222222-2222-2222-2222-222222222222";
    const entry = makeWorkspaceEntry({ metadata: { active_setup_session_id: sessionId } });
    const { manager, updateWorkspaceStatus } = makeManager(entry);
    mockChatStorage.getChat.mockResolvedValueOnce({
      ok: true,
      data: { id: sessionId, workspaceId: entry.id },
    });

    const result = await recoverBootstrapSessionIfDeleted({
      manager,
      workspace: entry,
      parsedConfig,
      setupRequirements,
      userId: "user-1",
    });

    expect(result).toEqual({ recovered: false, bootstrap_session_id: sessionId });
    expect(mockChatStorage.createChat).not.toHaveBeenCalled();
    expect(mockElicitationStorage.create).not.toHaveBeenCalled();
    expect(updateWorkspaceStatus).not.toHaveBeenCalled();
  });

  test("no pointer set (re-setup case) → no-op", async () => {
    const entry = makeWorkspaceEntry({ metadata: { createdBy: "user-1" } });
    const { manager, updateWorkspaceStatus } = makeManager(entry);

    const result = await recoverBootstrapSessionIfDeleted({
      manager,
      workspace: entry,
      parsedConfig,
      setupRequirements,
      userId: "user-1",
    });

    expect(result).toEqual({ recovered: false, bootstrap_session_id: null });
    expect(mockChatStorage.getChat).not.toHaveBeenCalled();
    expect(mockChatStorage.createChat).not.toHaveBeenCalled();
    expect(mockElicitationStorage.create).not.toHaveBeenCalled();
    expect(updateWorkspaceStatus).not.toHaveBeenCalled();
  });

  test("elicitation re-seed failure → pointer left stale for next-read retry", async () => {
    const previousSessionId = "33333333-3333-3333-3333-333333333333";
    const entry = makeWorkspaceEntry({ metadata: { active_setup_session_id: previousSessionId } });
    const { manager, updateWorkspaceStatus } = makeManager(entry);
    mockChatStorage.getChat.mockResolvedValueOnce({ ok: true, data: null });
    mockElicitationStorage.create.mockResolvedValueOnce({ ok: false, error: "kv down" });

    await expect(
      recoverBootstrapSessionIfDeleted({
        manager,
        workspace: entry,
        parsedConfig,
        setupRequirements,
        userId: "user-1",
      }),
    ).rejects.toThrow(/Failed to re-seed bootstrap elicitation: kv down/);

    expect(updateWorkspaceStatus).not.toHaveBeenCalled();
  });

  test("concurrent recovery on the same workspace is single-flight (one chat, one elicitation)", async () => {
    // Regression for the orphan-chat race: two concurrent GETs (sidebar
    // list + direct chat URL) both observed a deleted pointer, both
    // executed createChat + ElicitationStorage.create + appendMessage +
    // updateWorkspaceStatus. Last writer wins on the pointer; the loser's
    // chat + elicitation rows are orphaned with no way to clean them up.
    //
    // Recovery must single-flight per workspace id: the second caller
    // should observe the winner's session id, not race-create its own.
    const previousSessionId = "44444444-4444-4444-4444-444444444444";
    const entry = makeWorkspaceEntry({
      metadata: { createdBy: "user-1", active_setup_session_id: previousSessionId },
    });
    const { manager, updateWorkspaceStatus } = makeManager(entry);
    // Both callers see a deleted chat — `.mockResolvedValue` (no Once)
    // so the second concurrent caller also fails the pointer-valid check.
    mockChatStorage.getChat.mockResolvedValue({ ok: true, data: null });

    const [first, second] = await Promise.all([
      recoverBootstrapSessionIfDeleted({
        manager,
        workspace: entry,
        parsedConfig,
        setupRequirements,
        userId: "user-1",
      }),
      recoverBootstrapSessionIfDeleted({
        manager,
        workspace: entry,
        parsedConfig,
        setupRequirements,
        userId: "user-1",
      }),
    ]);

    // Exactly ONE chat + elicitation + metadata write — the loser sees
    // the winner's session id, not its own freshly-generated one.
    expect(mockChatStorage.createChat).toHaveBeenCalledTimes(1);
    expect(mockElicitationStorage.create).toHaveBeenCalledTimes(1);
    expect(updateWorkspaceStatus).toHaveBeenCalledTimes(1);

    // Both callers report the same recovered session id.
    expect(first.bootstrap_session_id).toBe(second.bootstrap_session_id);
    expect(first.bootstrap_session_id).toMatch(/^chat_[A-Za-z0-9]{10}$/);
  });
});
