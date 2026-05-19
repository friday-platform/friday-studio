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
    mockChatStorage: { createChat: vi.fn(), getChat: vi.fn() },
    mockElicitationStorage: { create: vi.fn() },
    mockAssembleLinkState: vi.fn(),
    mockLoadEnv: vi.fn(),
  }),
);

vi.mock("@atlas/core/chat/storage", () => ({ ChatStorage: mockChatStorage }));
vi.mock("@atlas/core/elicitations", () => ({ ElicitationStorage: mockElicitationStorage }));
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
    mockElicitationStorage.create.mockResolvedValue({ ok: true, data: {} });
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
    expect(result.bootstrap_session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.setup_requirements).toEqual([
      { kind: "variable", name: "region", description: "AWS region", schema: { type: "string" } },
    ]);

    // Exactly one chat, exactly one elicitation, both scoped to the same id.
    expect(mockChatStorage.createChat).toHaveBeenCalledTimes(1);
    expect(mockElicitationStorage.create).toHaveBeenCalledTimes(1);

    const chatArgs = mockChatStorage.createChat.mock.calls[0]?.[0];
    expect(chatArgs).toMatchObject({
      chatId: result.bootstrap_session_id,
      userId: "user-1",
      workspaceId: entry.id,
      source: "atlas",
    });

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
    expect(writtenMetadata?.active_setup_session_id).toMatch(/^[0-9a-f-]{36}$/);
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockChatStorage.createChat.mockResolvedValue({ ok: true, data: {} });
    mockElicitationStorage.create.mockResolvedValue({ ok: true, data: {} });
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
      setupRequirements,
      userId: "user-1",
    });

    expect(result.recovered).toBe(true);
    expect(result.bootstrap_session_id).toMatch(/^[0-9a-f-]{36}$/);
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
        setupRequirements,
        userId: "user-1",
      }),
    ).rejects.toThrow(/Failed to re-seed bootstrap elicitation: kv down/);

    expect(updateWorkspaceStatus).not.toHaveBeenCalled();
  });
});
