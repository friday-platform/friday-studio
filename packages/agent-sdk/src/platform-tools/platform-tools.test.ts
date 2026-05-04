import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HistoryEntry,
  MemoryAdapter,
  NarrativeEntry,
  NarrativeStore,
  StoreMetadata,
} from "../memory-adapter.ts";
import { createPlatformTools, PLATFORM_TOOL_NAMES } from "../platform-tools.ts";
import type { ScratchpadAdapter, ScratchpadChunk } from "../scratchpad-adapter.ts";
import type { AgentContext, AgentSessionData, Logger, PlatformModels } from "../types.ts";
import { createScratchpadTools } from "./scratchpad-tools.ts";
import { resolveStore } from "./store-resolve.ts";

const TOOL_CALL_OPTS = { toolCallId: "tc1", messages: [] };

function mockLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => mockLogger()),
  };
}

function mockNarrativeStore(): NarrativeStore {
  return {
    append: vi
      .fn<(entry: NarrativeEntry) => Promise<NarrativeEntry>>()
      .mockImplementation((entry) => Promise.resolve(entry)),
    read: vi
      .fn<(opts?: { since?: string; limit?: number }) => Promise<NarrativeEntry[]>>()
      .mockResolvedValue([]),
    search: vi.fn<(query: string) => Promise<NarrativeEntry[]>>().mockResolvedValue([]),
    forget: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    render: vi.fn<() => Promise<string>>().mockResolvedValue(""),
  };
}

function mockScratchpadAdapter(): ScratchpadAdapter {
  return {
    append: vi
      .fn<(key: string, chunk: ScratchpadChunk) => Promise<void>>()
      .mockResolvedValue(undefined),
    read: vi.fn<(key: string) => Promise<ScratchpadChunk[]>>().mockResolvedValue([]),
    clear: vi.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined),
    promote: vi
      .fn()
      .mockResolvedValue({ id: "p1", text: "promoted", createdAt: "2026-01-01T00:00:00Z" }),
  };
}

function mockMemoryAdapter(storeMap: Record<string, NarrativeStore> = {}): MemoryAdapter {
  return {
    store: vi.fn().mockImplementation((_wsId: string, name: string) => {
      const c = storeMap[name];
      if (!c) return Promise.reject(new Error(`Store ${name} not found`));
      return Promise.resolve(c);
    }),
    list: vi.fn<(wsId: string) => Promise<StoreMetadata[]>>().mockResolvedValue([]),
    bootstrap: vi.fn<(wsId: string, agentId: string) => Promise<string>>().mockResolvedValue(""),
    history: vi.fn<(wsId: string) => Promise<HistoryEntry[]>>().mockResolvedValue([]),
    rollback: vi
      .fn<(wsId: string, store: string, toVersion: string) => Promise<void>>()
      .mockResolvedValue(undefined),
  };
}

const mockPlatformModels: PlatformModels = {
  get: () => {
    throw new Error("platformModels.get should not be called in these tests");
  },
};

function createMockContext(overrides?: {
  adapter?: MemoryAdapter;
  scratchpad?: ScratchpadAdapter;
}): AgentContext {
  return {
    session: {
      sessionId: "s1",
      workspaceId: "ws1",
    } satisfies Partial<AgentSessionData> as AgentSessionData,
    tools: {},
    env: {},
    stream: undefined,
    logger: mockLogger(),
    memory: { mounts: {}, adapter: overrides?.adapter, scratchpad: overrides?.scratchpad },
    platformModels: mockPlatformModels,
  };
}

// ── resolveStore ─────────────────────────────────────────────────────────────

describe("resolveStore", () => {
  it("calls adapter.store with workspaceId and name", async () => {
    const nc = mockNarrativeStore();
    const adapter = mockMemoryAdapter({ notes: nc });
    const ctx = createMockContext({ adapter });

    const result = await resolveStore(ctx, "notes");
    expect(result).toBe(nc);
    expect(adapter.store).toHaveBeenCalledWith("ws1", "notes");
  });

  it("throws when adapter is not available", async () => {
    const ctx = createMockContext();
    ctx.memory = { mounts: {} };

    await expect(resolveStore(ctx, "notes")).rejects.toThrow(
      "MemoryAdapter not available on agent context",
    );
  });
});

// ── scratchpad tools ──────────────────────────────────────────────────────────

describe("scratchpad tools", () => {
  let sp: ScratchpadAdapter;
  let ctx: AgentContext;

  beforeEach(() => {
    sp = mockScratchpadAdapter();
    ctx = createMockContext({ scratchpad: sp });
  });

  it("append calls adapter.append(sessionKey, chunk)", async () => {
    const tools = createScratchpadTools(ctx);
    const exec = tools.scratchpad_append.execute;
    if (!exec) throw new Error("execute missing");

    const chunk = {
      id: "c1",
      kind: "thought",
      body: "thinking...",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const result = await exec({ sessionKey: "sess1", chunk }, TOOL_CALL_OPTS);

    expect(sp.append).toHaveBeenCalledWith("sess1", chunk);
    expect(result).toEqual({ ok: true });
  });

  it("read calls adapter.read(sessionKey, {since}) and returns chunks", async () => {
    const chunks = [
      { id: "c1", kind: "thought", body: "hello", createdAt: "2026-01-01T00:00:00Z" },
    ];
    vi.mocked(sp.read).mockResolvedValue(chunks);

    const tools = createScratchpadTools(ctx);
    const exec = tools.scratchpad_read.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec({ sessionKey: "sess1", since: "2025-01-01" }, TOOL_CALL_OPTS);
    expect(sp.read).toHaveBeenCalledWith("sess1", { since: "2025-01-01" });
    expect(result).toEqual(chunks);
  });

  it("clear calls adapter.clear(sessionKey)", async () => {
    const tools = createScratchpadTools(ctx);
    const exec = tools.scratchpad_clear.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec({ sessionKey: "sess1" }, TOOL_CALL_OPTS);
    expect(sp.clear).toHaveBeenCalledWith("sess1");
    expect(result).toEqual({ ok: true });
  });
});

// ── PLATFORM_TOOL_NAMES ───────────────────────────────────────────────────────

describe("PLATFORM_TOOL_NAMES", () => {
  it("includes the three memory tools", () => {
    expect(PLATFORM_TOOL_NAMES.has("memory_save")).toBe(true);
    expect(PLATFORM_TOOL_NAMES.has("memory_read")).toBe(true);
    expect(PLATFORM_TOOL_NAMES.has("memory_remove")).toBe(true);
  });

  it("includes the three scratchpad tools", () => {
    expect(PLATFORM_TOOL_NAMES.has("scratchpad_append")).toBe(true);
    expect(PLATFORM_TOOL_NAMES.has("scratchpad_read")).toBe(true);
    expect(PLATFORM_TOOL_NAMES.has("scratchpad_clear")).toBe(true);
  });

  it("does not include removed retrieval/dedup/kv tools", () => {
    for (const name of [
      "memory_retrieval_ingest",
      "memory_retrieval_query",
      "memory_dedup_append",
      "memory_dedup_filter",
      "memory_kv_get",
      "memory_kv_set",
      "memory_kv_delete",
    ]) {
      expect(PLATFORM_TOOL_NAMES.has(name)).toBe(false);
    }
  });
});

// ── createPlatformTools integration ───────────────────────────────────────────

describe("createPlatformTools", () => {
  it("returns scratchpad tools", () => {
    const sp = mockScratchpadAdapter();
    const ctx = createMockContext({ scratchpad: sp });

    const tools = createPlatformTools(ctx);

    for (const key of ["scratchpad_append", "scratchpad_read", "scratchpad_clear"]) {
      expect(tools).toHaveProperty(key);
      expect(PLATFORM_TOOL_NAMES.has(key)).toBe(true);
    }
  });
});
