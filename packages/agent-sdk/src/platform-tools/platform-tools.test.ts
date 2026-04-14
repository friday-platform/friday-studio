import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CorpusMetadata,
  DedupCorpus,
  DedupEntry,
  HistoryEntry,
  KVCorpus,
  MemoryAdapter,
  NarrativeCorpus,
  NarrativeEntry,
  RetrievalCorpus,
} from "../memory-adapter.ts";
import { createPlatformTools, PLATFORM_TOOL_NAMES } from "../platform-tools.ts";
import type { ScratchpadAdapter, ScratchpadChunk } from "../scratchpad-adapter.ts";
import type { AgentContext, AgentSessionData, Logger } from "../types.ts";
import { resolveCorpus } from "./corpus-resolve.ts";
import { createMemoryDedupTools } from "./memory-dedup-tools.ts";
import { createMemoryKVTools } from "./memory-kv-tools.ts";
import {
  createMemoryNarrativeTools,
  MemoryNarrativeAppendInput,
  MemoryNarrativeForgetInput,
  MemoryNarrativeReadInput,
  MemoryNarrativeSearchInput,
} from "./memory-narrative-tools.ts";
import { createMemoryRetrievalTools } from "./memory-retrieval-tools.ts";
import { createScratchpadTools } from "./scratchpad-tools.ts";

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

function mockNarrativeCorpus(): NarrativeCorpus {
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

function mockRetrievalCorpus(): RetrievalCorpus {
  return {
    ingest: vi.fn().mockResolvedValue({ ingested: 2, skipped: 0 }),
    query: vi.fn().mockResolvedValue([]),
    stats: vi.fn().mockResolvedValue({ count: 0, sizeBytes: 0 }),
    reset: vi.fn().mockResolvedValue(undefined),
  };
}

function mockDedupCorpus(): DedupCorpus {
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

function mockKVCorpus(): KVCorpus {
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

function mockMemoryAdapter(corpusMap: Record<string, unknown> = {}): MemoryAdapter {
  return {
    corpus: vi.fn().mockImplementation((_wsId: string, name: string) => {
      const c = corpusMap[name];
      if (!c) return Promise.reject(new Error(`Corpus ${name} not found`));
      return Promise.resolve(c);
    }),
    list: vi.fn<(wsId: string) => Promise<CorpusMetadata[]>>().mockResolvedValue([]),
    bootstrap: vi.fn<(wsId: string, agentId: string) => Promise<string>>().mockResolvedValue(""),
    history: vi.fn<(wsId: string) => Promise<HistoryEntry[]>>().mockResolvedValue([]),
    rollback: vi
      .fn<(wsId: string, corpus: string, toVersion: string) => Promise<void>>()
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

// ── resolveCorpus ─────────────────────────────────────────────────────────────

describe("resolveCorpus", () => {
  it("calls adapter.corpus with workspaceId, name, and kind", async () => {
    const nc = mockNarrativeCorpus();
    const adapter = mockMemoryAdapter({ notes: nc });
    const ctx = createMockContext({ adapter });

    const result = await resolveCorpus(ctx, "notes", "narrative");
    expect(result).toBe(nc);
    expect(adapter.corpus).toHaveBeenCalledWith("ws1", "notes", "narrative");
  });

  it("throws when adapter is not available", async () => {
    const ctx = createMockContext();
    ctx.memory = { mounts: {} };

    await expect(resolveCorpus(ctx, "notes", "narrative")).rejects.toThrow(
      "MemoryAdapter not available on agent context",
    );
  });
});

// ── memory_narrative tools ────────────────────────────────────────────────────

describe("memory_narrative tools", () => {
  let nc: NarrativeCorpus;
  let ctx: AgentContext;

  beforeEach(() => {
    nc = mockNarrativeCorpus();
    ctx = createMockContext({ adapter: mockMemoryAdapter({ journal: nc }) });
  });

  it("append calls corpus.append with NarrativeEntry and returns the persisted entry", async () => {
    const entry = { id: "e1", text: "hello", createdAt: "2026-01-01T00:00:00Z" };
    const tools = createMemoryNarrativeTools(ctx);
    const exec = tools.memory_narrative_append.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec({ corpus: "journal", entry }, TOOL_CALL_OPTS);
    expect(nc.append).toHaveBeenCalledWith(entry);
    expect(result).toEqual(entry);
  });

  it("read calls corpus.read with since/limit opts and returns entries", async () => {
    const entries = [{ id: "e1", text: "a", createdAt: "2026-01-01T00:00:00Z" }];
    vi.mocked(nc.read).mockResolvedValue(entries);

    const tools = createMemoryNarrativeTools(ctx);
    const exec = tools.memory_narrative_read.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec(
      { corpus: "journal", since: "2025-01-01", limit: 10 },
      TOOL_CALL_OPTS,
    );
    expect(nc.read).toHaveBeenCalledWith({ since: "2025-01-01", limit: 10 });
    expect(result).toEqual(entries);
  });

  it("search calls corpus.search with query + SearchOpts and returns entries", async () => {
    const hits = [{ id: "e2", text: "match", createdAt: "2026-01-01T00:00:00Z" }];
    vi.mocked(nc.search).mockResolvedValue(hits);

    const tools = createMemoryNarrativeTools(ctx);
    const exec = tools.memory_narrative_search.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec({ corpus: "journal", query: "hello", limit: 5 }, TOOL_CALL_OPTS);
    expect(nc.search).toHaveBeenCalledWith("hello", { limit: 5 });
    expect(result).toEqual(hits);
  });

  it("forget calls corpus.forget(id) and returns ack", async () => {
    const tools = createMemoryNarrativeTools(ctx);
    const exec = tools.memory_narrative_forget.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec({ corpus: "journal", id: "e1" }, TOOL_CALL_OPTS);
    expect(nc.forget).toHaveBeenCalledWith("e1");
    expect(result).toEqual({ ok: true });
  });
});

// ── memory_retrieval tools ────────────────────────────────────────────────────

describe("memory_retrieval tools", () => {
  let rc: RetrievalCorpus;
  let ctx: AgentContext;

  beforeEach(() => {
    rc = mockRetrievalCorpus();
    ctx = createMockContext({ adapter: mockMemoryAdapter({ docs: rc }) });
  });

  it("ingest calls corpus.ingest with DocBatch + IngestOpts and returns IngestResult", async () => {
    const tools = createMemoryRetrievalTools(ctx);
    const exec = tools.memory_retrieval_ingest.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec(
      { corpus: "docs", docs: [{ id: "d1", text: "doc text" }], chunker: "sentence" },
      TOOL_CALL_OPTS,
    );

    expect(rc.ingest).toHaveBeenCalledWith(
      { docs: [{ id: "d1", text: "doc text" }] },
      { chunker: "sentence", embedder: undefined },
    );
    expect(result).toEqual({ ingested: 2, skipped: 0 });
  });

  it("query calls corpus.query with RetrievalQuery + RetrievalOpts and returns Hit[]", async () => {
    const hits = [{ id: "d1", score: 0.9, text: "result", metadata: {} }];
    vi.mocked(rc.query).mockResolvedValue(hits);

    const tools = createMemoryRetrievalTools(ctx);
    const exec = tools.memory_retrieval_query.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec(
      { corpus: "docs", text: "query text", topK: 3, filter: { type: "article" } },
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
  let dc: DedupCorpus;
  let ctx: AgentContext;

  beforeEach(() => {
    dc = mockDedupCorpus();
    ctx = createMockContext({ adapter: mockMemoryAdapter({ dedup: dc }) });
  });

  it("append calls corpus.append(namespace, entry, ttlHours)", async () => {
    const tools = createMemoryDedupTools(ctx);
    const exec = tools.memory_dedup_append.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec(
      { corpus: "dedup", namespace: "urls", entry: { url: "https://example.com" }, ttlHours: 24 },
      TOOL_CALL_OPTS,
    );

    expect(dc.append).toHaveBeenCalledWith("urls", { url: "https://example.com" }, 24);
    expect(result).toEqual({ ok: true });
  });

  it("filter calls corpus.filter(namespace, field, values) and returns filtered values", async () => {
    const tools = createMemoryDedupTools(ctx);
    const exec = tools.memory_dedup_filter.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec(
      { corpus: "dedup", namespace: "urls", field: "url", values: ["a", "b"] },
      TOOL_CALL_OPTS,
    );

    expect(dc.filter).toHaveBeenCalledWith("urls", "url", ["a", "b"]);
    expect(result).toEqual(["a"]);
  });
});

// ── memory_kv tools ───────────────────────────────────────────────────────────

describe("memory_kv tools", () => {
  let kv: KVCorpus;
  let ctx: AgentContext;

  beforeEach(() => {
    kv = mockKVCorpus();
    ctx = createMockContext({ adapter: mockMemoryAdapter({ cache: kv }) });
  });

  it("get calls corpus.get(key) and returns value", async () => {
    const tools = createMemoryKVTools(ctx);
    const exec = tools.memory_kv_get.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec({ corpus: "cache", key: "greeting" }, TOOL_CALL_OPTS);
    expect(kv.get).toHaveBeenCalledWith("greeting");
    expect(result).toEqual({ value: "hello" });
  });

  it("get returns null for undefined values", async () => {
    vi.mocked(kv.get).mockResolvedValue(undefined);

    const tools = createMemoryKVTools(ctx);
    const exec = tools.memory_kv_get.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec({ corpus: "cache", key: "missing" }, TOOL_CALL_OPTS);
    expect(result).toEqual({ value: null });
  });

  it("set calls corpus.set(key, value, ttlSeconds)", async () => {
    const tools = createMemoryKVTools(ctx);
    const exec = tools.memory_kv_set.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec(
      { corpus: "cache", key: "greeting", value: "world", ttlSeconds: 300 },
      TOOL_CALL_OPTS,
    );

    expect(kv.set).toHaveBeenCalledWith("greeting", "world", 300);
    expect(result).toEqual({ ok: true });
  });

  it("delete calls corpus.delete(key)", async () => {
    const tools = createMemoryKVTools(ctx);
    const exec = tools.memory_kv_delete.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec({ corpus: "cache", key: "greeting" }, TOOL_CALL_OPTS);
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
  const newToolNames = [
    "memory_narrative_append",
    "memory_narrative_read",
    "memory_narrative_search",
    "memory_narrative_forget",
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

  it("includes all 14 new tool names", () => {
    for (const name of newToolNames) {
      expect(PLATFORM_TOOL_NAMES.has(name)).toBe(true);
    }
  });
});

// ── createPlatformTools integration ───────────────────────────────────────────

describe("createPlatformTools", () => {
  it("returns tools matching PLATFORM_TOOL_NAMES entries for memory/scratchpad", () => {
    const nc = mockNarrativeCorpus();
    const rc = mockRetrievalCorpus();
    const dc = mockDedupCorpus();
    const kv = mockKVCorpus();
    const adapter = mockMemoryAdapter({ n: nc, r: rc, d: dc, k: kv });
    const sp = mockScratchpadAdapter();
    const ctx = createMockContext({ adapter, scratchpad: sp });

    const tools = createPlatformTools(ctx);

    const expectedKeys = [
      "memory_narrative_append",
      "memory_narrative_read",
      "memory_narrative_search",
      "memory_narrative_forget",
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

// ── Zod validation ────────────────────────────────────────────────────────────

describe("Zod validation rejects malformed inputs", () => {
  it("MemoryNarrativeAppendInput rejects missing entry", () => {
    const result = MemoryNarrativeAppendInput.safeParse({ corpus: "x" });
    expect(result.success).toBe(false);
  });

  it("MemoryNarrativeReadInput rejects negative limit", () => {
    const result = MemoryNarrativeReadInput.safeParse({ corpus: "x", limit: -1 });
    expect(result.success).toBe(false);
  });

  it("MemoryNarrativeSearchInput rejects missing query", () => {
    const result = MemoryNarrativeSearchInput.safeParse({ corpus: "x" });
    expect(result.success).toBe(false);
  });

  it("MemoryNarrativeForgetInput rejects missing id", () => {
    const result = MemoryNarrativeForgetInput.safeParse({ corpus: "x" });
    expect(result.success).toBe(false);
  });

  it("tools surface errors as { error: string } when Zod validation fails", async () => {
    const ctx = createMockContext({ adapter: mockMemoryAdapter({ notes: mockNarrativeCorpus() }) });
    const tools = createMemoryNarrativeTools(ctx);
    const exec = tools.memory_narrative_append.execute;
    if (!exec) throw new Error("execute missing");

    const result = await exec({ corpus: "notes", entry: { bad: true } } as never, TOOL_CALL_OPTS);
    expect(result).toHaveProperty("error");
  });
});
