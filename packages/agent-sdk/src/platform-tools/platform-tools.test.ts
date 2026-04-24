import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DedupEntry,
  DedupStore,
  HistoryEntry,
  KVStore,
  MemoryAdapter,
  NarrativeEntry,
  NarrativeStore,
  RetrievalStore,
  StoreMetadata,
} from "../memory-adapter.ts";
import { createPlatformTools, PLATFORM_TOOL_NAMES } from "../platform-tools.ts";
import type { ScratchpadAdapter, ScratchpadChunk } from "../scratchpad-adapter.ts";
import type { AgentContext, AgentSessionData, Logger } from "../types.ts";
import { createMemoryDedupTools } from "./memory-dedup-tools.ts";
import { createMemoryKVTools } from "./memory-kv-tools.ts";
import { createMemoryRetrievalTools } from "./memory-retrieval-tools.ts";
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

function mockRetrievalStore(): RetrievalStore {
  return {
    ingest: vi.fn().mockResolvedValue({ ingested: 2, skipped: 0 }),
    query: vi.fn().mockResolvedValue([]),
    stats: vi.fn().mockResolvedValue({ count: 0, sizeBytes: 0 }),
    reset: vi.fn().mockResolvedValue(undefined),
  };
}

function mockDedupStore(): DedupStore {
  return {
    append: vi
      .fn<(ns: string, entry: DedupEntry, ttl?: number) => Promise<void>>()
      .mockResolvedValue(undefined),
    filter: vi
      .fn<(ns: string, field: string, values: unknown[]) => Promise<unknown[]>>()
      .mockResolvedValue(["a"]),
    clear: vi.fn<(ns: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}

function mockKVStore(): KVStore {
  return {
    get: vi.fn().mockResolvedValue("hello"),
    set: vi
      .fn<(key: string, value: unknown, ttl?: number) => Promise<void>>()
      .mockResolvedValue(undefined),
    delete: vi.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined),
    list: vi.fn<(prefix?: string) => Promise<string[]>>().mockResolvedValue([]),
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

function mockMemoryAdapter(storeMap: Record<string, unknown> = {}): MemoryAdapter {
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
  };
}

// ── resolveStore ─────────────────────────────────────────────────────────────

describe("resolveStore", () => {
  it("calls adapter.store with workspaceId, name, and kind", async () => {
    const nc = mockNarrativeStore();
    const adapter = mockMemoryAdapter({ notes: nc });
    const ctx = createMockContext({ adapter });

    const result = await resolveStore(ctx, "notes", "narrative");
    expect(result).toBe(nc);
    expect(adapter.store).toHaveBeenCalledWith("ws1", "notes", "narrative");
  });

  it("throws when adapter is not available", async () => {
    const ctx = createMockContext();
    ctx.memory = { mounts: {} };

    await expect(resolveStore(ctx, "notes", "narrative")).rejects.toThrow(
      "MemoryAdapter not available on agent context",
    );
  });
});

// ── memory_retrieval tools ────────────────────────────────────────────────────

describe("memory_retrieval tools", () => {
  let rc: RetrievalStore;
  let ctx: AgentContext;

  beforeEach(() => {
    rc = mockRetrievalStore();
    ctx = createMockContext({ adapter: mockMemoryAdapter({ docs: rc }) });
  });

  it("ingest calls store.ingest with DocBatch + IngestOpts and returns IngestResult", async () => {
    const tools = createMemoryRetrievalTools(ctx);
    const exec = tools.memory_retrieval_ingest.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec(
      { store: "docs", docs: [{ id: "d1", text: "doc text" }], chunker: "sentence" },
      TOOL_CALL_OPTS,
    );

    expect(rc.ingest).toHaveBeenCalledWith(
      { docs: [{ id: "d1", text: "doc text" }] },
      { chunker: "sentence", embedder: undefined },
    );
    expect(result).toEqual({ ingested: 2, skipped: 0 });
  });

  it("query calls store.query with RetrievalQuery + RetrievalOpts and returns Hit[]", async () => {
    const hits = [{ id: "d1", score: 0.9, text: "result", metadata: {} }];
    vi.mocked(rc.query).mockResolvedValue(hits);

    const tools = createMemoryRetrievalTools(ctx);
    const exec = tools.memory_retrieval_query.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec(
      { store: "docs", text: "query text", topK: 3, filter: { type: "article" } },
      TOOL_CALL_OPTS,
    );

    expect(rc.query).toHaveBeenCalledWith(
      { text: "query text", topK: 3 },
      { filter: { type: "article" } },
    );
    expect(result).toEqual(hits);
  });
});

// ── memory_dedup tools ────────────────────────────────────────────────────────

describe("memory_dedup tools", () => {
  let dc: DedupStore;
  let ctx: AgentContext;

  beforeEach(() => {
    dc = mockDedupStore();
    ctx = createMockContext({ adapter: mockMemoryAdapter({ dedup: dc }) });
  });

  it("append calls store.append(namespace, entry, ttlHours)", async () => {
    const tools = createMemoryDedupTools(ctx);
    const exec = tools.memory_dedup_append.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec(
      { store: "dedup", namespace: "urls", entry: { url: "https://example.com" }, ttlHours: 24 },
      TOOL_CALL_OPTS,
    );

    expect(dc.append).toHaveBeenCalledWith("urls", { url: "https://example.com" }, 24);
    expect(result).toEqual({ ok: true });
  });

  it("filter calls store.filter(namespace, field, values) and returns filtered values", async () => {
    const tools = createMemoryDedupTools(ctx);
    const exec = tools.memory_dedup_filter.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec(
      { store: "dedup", namespace: "urls", field: "url", values: ["a", "b"] },
      TOOL_CALL_OPTS,
    );

    expect(dc.filter).toHaveBeenCalledWith("urls", "url", ["a", "b"]);
    expect(result).toEqual(["a"]);
  });
});

// ── memory_kv tools ───────────────────────────────────────────────────────────

describe("memory_kv tools", () => {
  let kv: KVStore;
  let ctx: AgentContext;

  beforeEach(() => {
    kv = mockKVStore();
    ctx = createMockContext({ adapter: mockMemoryAdapter({ cache: kv }) });
  });

  it("get calls store.get(key) and returns value", async () => {
    const tools = createMemoryKVTools(ctx);
    const exec = tools.memory_kv_get.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec({ store: "cache", key: "greeting" }, TOOL_CALL_OPTS);
    expect(kv.get).toHaveBeenCalledWith("greeting");
    expect(result).toEqual({ value: "hello" });
  });

  it("get returns null for undefined values", async () => {
    vi.mocked(kv.get).mockResolvedValue(undefined);

    const tools = createMemoryKVTools(ctx);
    const exec = tools.memory_kv_get.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec({ store: "cache", key: "missing" }, TOOL_CALL_OPTS);
    expect(result).toEqual({ value: null });
  });

  it("set calls store.set(key, value, ttlSeconds)", async () => {
    const tools = createMemoryKVTools(ctx);
    const exec = tools.memory_kv_set.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec(
      { store: "cache", key: "greeting", value: "world", ttlSeconds: 300 },
      TOOL_CALL_OPTS,
    );

    expect(kv.set).toHaveBeenCalledWith("greeting", "world", 300);
    expect(result).toEqual({ ok: true });
  });

  it("delete calls store.delete(key)", async () => {
    const tools = createMemoryKVTools(ctx);
    const exec = tools.memory_kv_delete.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec({ store: "cache", key: "greeting" }, TOOL_CALL_OPTS);
    expect(kv.delete).toHaveBeenCalledWith("greeting");
    expect(result).toEqual({ ok: true });
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
  const expectedToolNames = [
    "memory_save",
    "memory_read",
    "memory_remove",
    "memory_retrieval_ingest",
    "memory_retrieval_query",
    "memory_dedup_append",
    "memory_dedup_filter",
    "memory_kv_get",
    "memory_kv_set",
    "memory_kv_delete",
    "scratchpad_append",
    "scratchpad_read",
    "scratchpad_clear",
  ];

  it("includes all expected tool names", () => {
    for (const name of expectedToolNames) {
      expect(PLATFORM_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it("does not include removed narrative aliases", () => {
    expect(PLATFORM_TOOL_NAMES.has("memory_narrative_append")).toBe(false);
    expect(PLATFORM_TOOL_NAMES.has("memory_narrative_read")).toBe(false);
    expect(PLATFORM_TOOL_NAMES.has("memory_narrative_forget")).toBe(false);
  });
});

// ── createPlatformTools integration ───────────────────────────────────────────

describe("createPlatformTools", () => {
  it("returns tools matching PLATFORM_TOOL_NAMES entries for memory/scratchpad", () => {
    const nc = mockNarrativeStore();
    const rc = mockRetrievalStore();
    const dc = mockDedupStore();
    const kv = mockKVStore();
    const adapter = mockMemoryAdapter({ n: nc, r: rc, d: dc, k: kv });
    const sp = mockScratchpadAdapter();
    const ctx = createMockContext({ adapter, scratchpad: sp });

    const tools = createPlatformTools(ctx);

    const expectedKeys = [
      "memory_retrieval_ingest",
      "memory_retrieval_query",
      "memory_dedup_append",
      "memory_dedup_filter",
      "memory_kv_get",
      "memory_kv_set",
      "memory_kv_delete",
      "scratchpad_append",
      "scratchpad_read",
      "scratchpad_clear",
    ];

    for (const key of expectedKeys) {
      expect(tools).toHaveProperty(key);
      expect(PLATFORM_TOOL_NAMES.has(key)).toBe(true);
    }
  });
});
