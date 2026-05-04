import type {
  HistoryEntry,
  HistoryFilter,
  MemoryAdapter,
  NarrativeEntry,
  NarrativeStore,
  ResolvedWorkspaceMemory,
  StoreMetadata,
} from "@atlas/agent-sdk";
import { buildResolvedWorkspaceMemory } from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";

function createMockStore(): NarrativeStore {
  return {
    append: (_entry: NarrativeEntry) => Promise.resolve(_entry),
    read: () => Promise.resolve([]),
    search: () => Promise.resolve([]),
    forget: () => Promise.resolve(),
    render: () => Promise.resolve(""),
  };
}

function createMockAdapter(): MemoryAdapter {
  const store = createMockStore();
  return {
    store(_wsId: string, _name: string): Promise<NarrativeStore> {
      return Promise.resolve(store);
    },
    list: (_wsId: string): Promise<StoreMetadata[]> => Promise.resolve([]),
    bootstrap: (_wsId: string, _agentId: string): Promise<string> => Promise.resolve(""),
    history: (_wsId: string, _filter?: HistoryFilter): Promise<HistoryEntry[]> =>
      Promise.resolve([]),
    rollback: (_wsId: string, _store: string, _toVersion: string): Promise<void> =>
      Promise.resolve(),
  };
}

describe("buildResolvedWorkspaceMemory integration", () => {
  it("captures own stores from config", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries: [
        { name: "notes", type: "short_term" },
        { name: "backlog", type: "long_term", strategy: "narrative" },
      ],
      mountDeclarations: [],
      kernelWorkspaceId: "thick_endive",
    });

    expect(resolved.own).toHaveLength(2);
    expect(resolved.own[0]).toEqual({
      name: "notes",
      type: "short_term",
      strategy: undefined,
      scope: "workspace",
    });
    expect(resolved.own[1]).toEqual({
      name: "backlog",
      type: "long_term",
      strategy: "narrative",
      scope: "workspace",
    });
  });

  it("captures mount bindings with parsed source components", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries: [],
      mountDeclarations: [
        {
          name: "backlog",
          source: "thick_endive/narrative/autopilot-backlog",
          mode: "ro",
          scope: "workspace",
        },
        {
          name: "reflections",
          source: "_global/narrative/reflections",
          mode: "ro",
          scope: "agent",
          scopeTarget: "my-agent",
        },
      ],
      kernelWorkspaceId: "thick_endive",
    });

    expect(resolved.mounts).toHaveLength(2);
    expect(resolved.mounts[0]).toMatchObject({
      name: "backlog",
      sourceWorkspaceId: "thick_endive",
      sourceStoreKind: "narrative",
      sourceStoreName: "autopilot-backlog",
      mode: "ro",
    });
    expect(resolved.mounts[1]).toMatchObject({
      name: "reflections",
      sourceWorkspaceId: "_global",
      sourceStoreKind: "narrative",
      scope: "agent",
      scopeTarget: "my-agent",
    });
  });

  it("global write guard reflects kernel identity", () => {
    const kernelResolved = buildResolvedWorkspaceMemory({
      workspaceId: "thick_endive",
      ownEntries: [],
      mountDeclarations: [
        { name: "global-rw", source: "_global/narrative/orders", mode: "rw", scope: "workspace" },
      ],
      kernelWorkspaceId: "thick_endive",
    });
    expect(kernelResolved.globalAccess.canWrite).toBe(true);

    const userlandResolved = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries: [],
      mountDeclarations: [
        { name: "global-rw", source: "_global/narrative/orders", mode: "rw", scope: "workspace" },
      ],
      kernelWorkspaceId: "thick_endive",
    });
    expect(userlandResolved.globalAccess.canWrite).toBe(false);
  });

  it("empty config produces empty resolved state", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "empty_ws",
      ownEntries: [],
      mountDeclarations: [],
      kernelWorkspaceId: undefined,
    });

    expect(resolved.own).toHaveLength(0);
    expect(resolved.mounts).toHaveLength(0);
    expect(resolved.globalAccess).toEqual({ canRead: false, canWrite: false });
  });

  it("read-only global mount sets canRead=true, canWrite=false", () => {
    const resolved = buildResolvedWorkspaceMemory({
      workspaceId: "braised_biscuit",
      ownEntries: [],
      mountDeclarations: [
        { name: "orders", source: "_global/narrative/orders", mode: "ro", scope: "workspace" },
      ],
      kernelWorkspaceId: "thick_endive",
    });

    expect(resolved.globalAccess.canRead).toBe(true);
    expect(resolved.globalAccess.canWrite).toBe(false);
  });

  it("type satisfies ResolvedWorkspaceMemory interface", () => {
    const adapter: MemoryAdapter = createMockAdapter();
    expect(adapter.bootstrap).toBeDefined();

    const resolved: ResolvedWorkspaceMemory = buildResolvedWorkspaceMemory({
      workspaceId: "test",
      ownEntries: [],
      mountDeclarations: [],
      kernelWorkspaceId: undefined,
    });
    expect(resolved.workspaceId).toBe("test");
  });
});
