import type {
  MemoryAdapter,
  NarrativeEntry,
  NarrativeStore,
  StoreMetadata,
} from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";
import type { AgentMountConfig } from "./bootstrap.ts";
import {
  applyFilter,
  buildBootstrap,
  buildBootstrapBlock,
  DEFAULT_MOUNT_MAX_BYTES,
  DEFAULT_TOTAL_MAX_BYTES,
  renderSection,
  resolveBootstrap,
  seedMemories,
  sortByPriorityDesc,
  truncateToBytes,
} from "./bootstrap.ts";

function entry(overrides: Partial<NarrativeEntry> & { text: string }): NarrativeEntry {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    text: overrides.text,
    createdAt: overrides.createdAt ?? "2026-04-14T00:00:00Z",
    author: overrides.author,
    metadata: overrides.metadata,
  };
}

// ── applyFilter ─────────────────────────────────────────────────────────────

describe("applyFilter", () => {
  it("exact-match field returns only matching entries (e.g. status='pending' excludes status='done')", () => {
    const entries = [
      entry({ text: "a", metadata: { status: "pending" } }),
      entry({ text: "b", metadata: { status: "done" } }),
      entry({ text: "c", metadata: { status: "pending" } }),
    ];
    const result = applyFilter(entries, { status: "pending" });
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.text)).toEqual(["a", "c"]);
  });

  it("_min suffix (priority_min:90) excludes entries with metadata.priority < 90", () => {
    const entries = [
      entry({ text: "low", metadata: { priority: 50 } }),
      entry({ text: "exact", metadata: { priority: 90 } }),
      entry({ text: "high", metadata: { priority: 95 } }),
    ];
    const result = applyFilter(entries, { priority_min: 90 });
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.text)).toEqual(["exact", "high"]);
  });

  it("_max suffix (priority_max:50) excludes entries with metadata.priority > 50", () => {
    const entries = [
      entry({ text: "low", metadata: { priority: 30 } }),
      entry({ text: "exact", metadata: { priority: 50 } }),
      entry({ text: "high", metadata: { priority: 95 } }),
    ];
    const result = applyFilter(entries, { priority_max: 50 });
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.text)).toEqual(["low", "exact"]);
  });

  it("conjunction — all predicates must pass", () => {
    const entries = [
      entry({ text: "both-match", metadata: { status: "pending", category: "bug" } }),
      entry({ text: "status-only", metadata: { status: "pending", category: "feature" } }),
      entry({ text: "category-only", metadata: { status: "done", category: "bug" } }),
      entry({ text: "neither", metadata: { status: "done", category: "feature" } }),
    ];
    const result = applyFilter(entries, { status: "pending", category: "bug" });
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("both-match");
  });

  it("unknown filter key does not reject entries (permissive policy)", () => {
    const entries = [
      entry({ text: "a", metadata: { status: "pending" } }),
      entry({ text: "b", metadata: { priority: 50 } }),
    ];
    const result = applyFilter(entries, { nonexistent_field: "value" });
    expect(result).toHaveLength(2);
  });

  it("entry with no metadata object is excluded when filter has exact-match keys", () => {
    const entries = [
      entry({ text: "no-meta" }),
      entry({ text: "has-meta", metadata: { status: "pending" } }),
    ];
    const result = applyFilter(entries, { status: "pending" });
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("has-meta");
  });
});

// ── truncateToBytes ──────────────────────────────────────────────────────────

describe("truncateToBytes", () => {
  it("drops tail entries when accumulated byte length would exceed mountMaxBytes", () => {
    const longText = "x".repeat(500);
    const entries = [
      entry({ text: longText }),
      entry({ text: longText }),
      entry({ text: longText }),
    ];
    const { entries: kept } = truncateToBytes(entries, 600);
    expect(kept.length).toBeLessThan(3);
    expect(kept.length).toBeGreaterThan(0);
  });

  it("never truncates mid-entry", () => {
    const entries = [entry({ text: "short" }), entry({ text: "x".repeat(1000) })];
    const { entries: kept } = truncateToBytes(entries, 100);
    for (const e of kept) {
      expect(e.text).toBe("short");
    }
  });

  it("returns all entries when total is under cap", () => {
    const entries = [entry({ text: "short" }), entry({ text: "also short" })];
    const { entries: kept, truncated } = truncateToBytes(entries, DEFAULT_MOUNT_MAX_BYTES);
    expect(kept).toHaveLength(2);
    expect(truncated).toBe(false);
  });

  it("sets truncated flag when entries are dropped", () => {
    const entries = [entry({ text: "x".repeat(500) }), entry({ text: "x".repeat(500) })];
    const { truncated } = truncateToBytes(entries, 100);
    expect(truncated).toBe(true);
  });
});

// ── sortByPriorityDesc ──────────────────────────────────────────────────────

describe("sortByPriorityDesc", () => {
  it("entries with higher metadata.priority appear first", () => {
    const entries = [
      entry({ text: "low", metadata: { priority: 10 } }),
      entry({ text: "high", metadata: { priority: 99 } }),
      entry({ text: "mid", metadata: { priority: 50 } }),
    ];
    const sorted = sortByPriorityDesc(entries);
    expect(sorted.map((e) => e.text)).toEqual(["high", "mid", "low"]);
  });

  it("entries with no metadata.priority treated as priority 0", () => {
    const entries = [
      entry({ text: "no-prio" }),
      entry({ text: "has-prio", metadata: { priority: 5 } }),
      entry({ text: "also-no-prio", metadata: {} }),
    ];
    const sorted = sortByPriorityDesc(entries);
    expect(sorted[0]?.text).toBe("has-prio");
  });
});

// ── renderSection ──────────────────────────────────────────────────────────

describe("renderSection", () => {
  it("produces a ## heading with bullet entries", () => {
    const entries = [entry({ text: "Task A" }), entry({ text: "Task B" })];
    const result = renderSection("tasks", entries, false);
    expect(result).toContain("## tasks");
    expect(result).toContain("- Task A");
    expect(result).toContain("- Task B");
  });

  it("appends truncated comment when truncated is true", () => {
    const entries = [entry({ text: "visible" })];
    const result = renderSection("data", entries, true);
    expect(result).toContain("<!-- truncated -->");
  });

  it("omits truncated comment when truncated is false", () => {
    const entries = [entry({ text: "visible" })];
    const result = renderSection("data", entries, false);
    expect(result).not.toContain("<!-- truncated -->");
  });
});

// ── buildBootstrapBlock ─────────────────────────────────────────────────────

function mockAdapter(stores: Record<string, NarrativeEntry[]>): MemoryAdapter {
  return {
    store(_wid: string, name: string): Promise<NarrativeStore> {
      const data = stores[name] ?? [];
      const narrativeStore: NarrativeStore = {
        read: () => Promise.resolve(data),
        append: (e: NarrativeEntry) => Promise.resolve(e),
        search: () => Promise.resolve([]),
        forget: () => Promise.resolve(),
        render: () => Promise.resolve(data.map((e) => e.text).join("\n")),
      };
      return Promise.resolve(narrativeStore);
    },
    list: () => Promise.resolve([]),
    bootstrap: () => Promise.resolve(""),
    history: () => Promise.resolve([]),
    rollback: () => Promise.resolve(),
  };
}

describe("buildBootstrapBlock", () => {
  it("opens the named narrative store", async () => {
    const data = [entry({ text: "test" })];
    const namesSeen: string[] = [];

    const adapter: MemoryAdapter = {
      store(_wid: string, name: string): Promise<NarrativeStore> {
        namesSeen.push(name);
        const narrativeStore: NarrativeStore = {
          read: () => Promise.resolve(data),
          append: (e: NarrativeEntry) => Promise.resolve(e),
          search: () => Promise.resolve([]),
          forget: () => Promise.resolve(),
          render: () => Promise.resolve(""),
        };
        return Promise.resolve(narrativeStore);
      },
      list: () => Promise.resolve([]),
      bootstrap: () => Promise.resolve(""),
      history: () => Promise.resolve([]),
      rollback: () => Promise.resolve(),
    };

    await buildBootstrapBlock(adapter, "ws-1", [{ name: "tasks", store: "my-corpus" }]);
    expect(namesSeen).toEqual(["my-corpus"]);
  });

  it("sections appear in mount declaration order", async () => {
    const adapter = mockAdapter({
      alpha: [entry({ text: "A1" })],
      beta: [entry({ text: "B1" })],
      gamma: [entry({ text: "G1" })],
    });
    const mounts: AgentMountConfig[] = [
      { name: "alpha", store: "alpha" },
      { name: "beta", store: "beta" },
      { name: "gamma", store: "gamma" },
    ];
    const result = await buildBootstrapBlock(adapter, "ws-1", mounts);
    const alphaIdx = result.indexOf("## alpha");
    const betaIdx = result.indexOf("## beta");
    const gammaIdx = result.indexOf("## gamma");
    expect(alphaIdx).toBeLessThan(betaIdx);
    expect(betaIdx).toBeLessThan(gammaIdx);
  });

  it("total output is capped at DEFAULT_TOTAL_MAX_BYTES (32 KB)", async () => {
    const bigText = "x".repeat(2000);
    const bigEntries = Array.from({ length: 20 }, (_, i) => entry({ text: `${bigText}-${i}` }));

    const adapter = mockAdapter({ c1: bigEntries, c2: bigEntries, c3: bigEntries });

    const mounts: AgentMountConfig[] = [
      { name: "c1", store: "c1", bootstrap: { maxBytes: 20000 } },
      { name: "c2", store: "c2", bootstrap: { maxBytes: 20000 } },
      { name: "c3", store: "c3", bootstrap: { maxBytes: 20000 } },
    ];

    const result = await buildBootstrapBlock(adapter, "ws-1", mounts, {
      totalMaxBytes: DEFAULT_TOTAL_MAX_BYTES,
    });
    const encoder = new TextEncoder();
    expect(encoder.encode(result).byteLength).toBeLessThanOrEqual(DEFAULT_TOTAL_MAX_BYTES);
  });

  it("per-mount cap uses mount.bootstrap.maxBytes when provided", async () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      entry({
        text: `Entry ${i} with some text padding to increase size`,
        metadata: { priority: 50 - i },
      }),
    );

    const adapter = mockAdapter({ store1: entries });

    const smallCap: AgentMountConfig[] = [
      { name: "store1", store: "store1", bootstrap: { maxBytes: 256 } },
    ];
    const defaultCap: AgentMountConfig[] = [{ name: "store1", store: "store1" }];

    const smallResult = await buildBootstrapBlock(adapter, "ws-1", smallCap);
    const defaultResult = await buildBootstrapBlock(adapter, "ws-1", defaultCap);

    const smallBullets = smallResult.split("\n").filter((l) => l.startsWith("- "));
    const defaultBullets = defaultResult.split("\n").filter((l) => l.startsWith("- "));
    expect(smallBullets.length).toBeLessThan(defaultBullets.length);
  });

  it("per-mount cap falls back to DEFAULT_MOUNT_MAX_BYTES (8 KB) when not configured", async () => {
    const entries = Array.from({ length: 200 }, (_, i) =>
      entry({ text: `Entry ${i} ${"padding ".repeat(20)}`, metadata: { priority: 200 - i } }),
    );

    const adapter = mockAdapter({ store1: entries });
    const mounts: AgentMountConfig[] = [{ name: "store1", store: "store1" }];

    const result = await buildBootstrapBlock(adapter, "ws-1", mounts);
    const bullets = result.split("\n").filter((l) => l.startsWith("- "));
    const encoder = new TextEncoder();
    const bulletBytes = encoder.encode(bullets.map((b) => b + "\n").join("")).byteLength;
    expect(bulletBytes).toBeLessThanOrEqual(DEFAULT_MOUNT_MAX_BYTES);
  });

  it("returns empty string when agent has no bound mounts", async () => {
    const adapter = mockAdapter({});
    const result = await buildBootstrapBlock(adapter, "ws-1", []);
    expect(result).toBe("");
  });

  it("applies arbitrary metadata equality filters end-to-end", async () => {
    const adapter = mockAdapter({
      tasks: [
        entry({ text: "match", metadata: { category: "bug", team: "infra" } }),
        entry({ text: "wrong-cat", metadata: { category: "feature", team: "infra" } }),
        entry({ text: "wrong-team", metadata: { category: "bug", team: "frontend" } }),
      ],
    });
    const mounts: AgentMountConfig[] = [
      { name: "tasks", store: "tasks", filter: { category: "bug", team: "infra" } },
    ];
    const result = await buildBootstrapBlock(adapter, "ws-1", mounts);
    expect(result).toContain("- match");
    expect(result).not.toContain("wrong-cat");
    expect(result).not.toContain("wrong-team");
  });

  it("sorts surviving entries by priority desc before truncation", async () => {
    const adapter = mockAdapter({
      tasks: [
        entry({ text: "low", metadata: { priority: 10 } }),
        entry({ text: "high", metadata: { priority: 99 } }),
        entry({ text: "mid", metadata: { priority: 50 } }),
      ],
    });
    const mounts: AgentMountConfig[] = [{ name: "tasks", store: "tasks" }];
    const result = await buildBootstrapBlock(adapter, "ws-1", mounts);
    const bullets = result.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toEqual(["- high", "- mid", "- low"]);
  });

  it("renders each mount as a '## <name>' section with bullet-point entries", async () => {
    const adapter = mockAdapter({
      alpha: [entry({ text: "A1" }), entry({ text: "A2" })],
      beta: [entry({ text: "B1" })],
    });
    const mounts: AgentMountConfig[] = [
      { name: "alpha", store: "alpha" },
      { name: "beta", store: "beta" },
    ];
    const result = await buildBootstrapBlock(adapter, "ws-1", mounts);
    expect(result).toContain("## alpha");
    expect(result).toContain("- A1");
    expect(result).toContain("- A2");
    expect(result).toContain("## beta");
    expect(result).toContain("- B1");
  });

  it("sections are joined by double newline", async () => {
    const adapter = mockAdapter({
      first: [entry({ text: "F1" })],
      second: [entry({ text: "S1" })],
    });
    const mounts: AgentMountConfig[] = [
      { name: "first", store: "first" },
      { name: "second", store: "second" },
    ];
    const result = await buildBootstrapBlock(adapter, "ws-1", mounts);
    expect(result).toContain("## first\n- F1\n\n## second\n- S1");
  });

  it("with multiple mounts — earlier mounts are fully included before later ones are truncated", async () => {
    const bigEntries = Array.from({ length: 50 }, (_, i) =>
      entry({ text: `entry-${i} ${"x".repeat(500)}`, metadata: { priority: 50 - i } }),
    );
    const smallEntries = [entry({ text: "small" })];
    const adapter = mockAdapter({ big: bigEntries, small: smallEntries });
    const mounts: AgentMountConfig[] = [
      { name: "big", store: "big", bootstrap: { maxBytes: 8192 } },
      { name: "small", store: "small" },
    ];
    const result = await buildBootstrapBlock(adapter, "ws-1", mounts, { totalMaxBytes: 8200 });
    expect(result).toContain("## big");
    expect(result).not.toContain("## small");
  });

  it("returns empty string when all mounts have zero filtered entries", async () => {
    const adapter = mockAdapter({
      empty: [entry({ text: "done item", metadata: { status: "done" } })],
    });

    const mounts: AgentMountConfig[] = [
      { name: "empty", store: "empty", filter: { status: "pending" } },
    ];

    const result = await buildBootstrapBlock(adapter, "ws-1", mounts);
    expect(result).toBe("");
  });
});

// ── integration ─────────────────────────────────────────────────────────────

describe("integration", () => {
  it("agent with filter={status:'pending',priority_min:90} sees only pending entries with priority>=90", async () => {
    const adapter = mockAdapter({
      tasks: [
        entry({ text: "High-prio pending", metadata: { status: "pending", priority: 95 } }),
        entry({ text: "Low-prio pending", metadata: { status: "pending", priority: 50 } }),
        entry({ text: "High-prio done", metadata: { status: "done", priority: 99 } }),
        entry({ text: "No metadata" }),
      ],
    });

    const mounts: AgentMountConfig[] = [
      { name: "tasks", store: "tasks", filter: { status: "pending", priority_min: 90 } },
    ];

    const result = await buildBootstrapBlock(adapter, "ws-1", mounts);
    expect(result).toContain("High-prio pending");
    expect(result).not.toContain("Low-prio pending");
    expect(result).not.toContain("High-prio done");
    expect(result).not.toContain("No metadata");
    expect(result).toContain("## tasks");
  });
});

// ── resolveBootstrap (legacy) ───────────────────────────────────────────────

function mockResolveAdapter(
  stores: StoreMetadata[],
  renderResults: Record<string, string>,
): MemoryAdapter {
  return {
    store(_wid: string, name: string): Promise<NarrativeStore> {
      const narrativeStore: NarrativeStore = {
        read: () => Promise.resolve([]),
        append: (e: NarrativeEntry) => Promise.resolve(e),
        search: () => Promise.resolve([]),
        forget: () => Promise.resolve(),
        render: () => Promise.resolve(renderResults[name] ?? ""),
      };
      return Promise.resolve(narrativeStore);
    },
    list: () => Promise.resolve(stores),
    bootstrap: () => Promise.resolve(""),
    history: () => Promise.resolve([]),
    rollback: () => Promise.resolve(),
  };
}

describe("resolveBootstrap", () => {
  it("returns '' when adapter.list returns empty array", async () => {
    const adapter = mockResolveAdapter([], {});
    const result = await resolveBootstrap(adapter, "ws-1", "agent-1");
    expect(result).toBe("");
  });

  it("returns '' when all store.render() calls return whitespace-only strings", async () => {
    const stores: StoreMetadata[] = [
      { name: "c1", kind: "narrative", workspaceId: "ws-1" },
      { name: "c2", kind: "narrative", workspaceId: "ws-1" },
    ];
    const adapter = mockResolveAdapter(stores, { c1: "   ", c2: "\n\t\n" });
    const result = await resolveBootstrap(adapter, "ws-1", "agent-1");
    expect(result).toBe("");
  });

  it("concatenates non-empty renders with default separator", async () => {
    const stores: StoreMetadata[] = [
      { name: "c1", kind: "narrative", workspaceId: "ws-1" },
      { name: "c2", kind: "narrative", workspaceId: "ws-1" },
    ];
    const adapter = mockResolveAdapter(stores, { c1: "Block one", c2: "Block two" });
    const result = await resolveBootstrap(adapter, "ws-1", "agent-1");
    expect(result).toBe("Block one\n\nBlock two");
  });

  it("respects custom separator option", async () => {
    const stores: StoreMetadata[] = [
      { name: "c1", kind: "narrative", workspaceId: "ws-1" },
      { name: "c2", kind: "narrative", workspaceId: "ws-1" },
    ];
    const adapter = mockResolveAdapter(stores, { c1: "AAA", c2: "BBB" });
    const result = await resolveBootstrap(adapter, "ws-1", "agent-1", { separator: "---" });
    expect(result).toBe("AAA---BBB");
  });

  it("renders narrative stores filtered by workspaceId", async () => {
    const stores: StoreMetadata[] = [
      { name: "c-mine", kind: "narrative", workspaceId: "ws-1" },
      { name: "c-other", kind: "narrative", workspaceId: "ws-2" },
    ];
    const adapter = mockResolveAdapter(stores, {
      "c-mine": "Narrative content",
      "c-other": "Should not appear",
    });
    const result = await resolveBootstrap(adapter, "ws-1", "agent-1");
    expect(result).toBe("Narrative content");
  });
});

// ── buildBootstrap ───────────────────────────────────────────────────────

describe("buildBootstrap", () => {
  it("returns empty string when no narrative stores exist", async () => {
    const adapter = mockResolveAdapter([], {});
    const result = await buildBootstrap(adapter, "ws-1", "agent-1");
    expect(result).toBe("");
  });

  it("renders all narrative stores", async () => {
    const stores: StoreMetadata[] = [
      { name: "notes", kind: "narrative", workspaceId: "ws-1" },
      { name: "decisions", kind: "narrative", workspaceId: "ws-1" },
    ];
    const adapter = mockResolveAdapter(stores, {
      notes: "Important notes",
      decisions: "Decisions log",
    });
    const result = await buildBootstrap(adapter, "ws-1", "agent-1");
    expect(result).toBe("Important notes\n\nDecisions log");
  });

  it("returns empty string when all store renders are whitespace-only", async () => {
    const stores: StoreMetadata[] = [
      { name: "c1", kind: "narrative", workspaceId: "ws-1" },
      { name: "c2", kind: "narrative", workspaceId: "ws-1" },
    ];
    const adapter = mockResolveAdapter(stores, { c1: "   ", c2: "\n\t\n" });
    const result = await buildBootstrap(adapter, "ws-1", "agent-1");
    expect(result).toBe("");
  });

  it("concatenates multiple narrative store renders with double-newline separator", async () => {
    const stores: StoreMetadata[] = [
      { name: "c1", kind: "narrative", workspaceId: "ws-1" },
      { name: "c2", kind: "narrative", workspaceId: "ws-1" },
    ];
    const adapter = mockResolveAdapter(stores, { c1: "Block one", c2: "Block two" });
    const result = await buildBootstrap(adapter, "ws-1", "agent-1");
    expect(result).toBe("Block one\n\nBlock two");
  });

  it("propagates error when store.render() throws", async () => {
    const stores: StoreMetadata[] = [{ name: "broken", kind: "narrative", workspaceId: "ws-1" }];
    const adapter: MemoryAdapter = {
      store(_wid: string, _name: string): Promise<NarrativeStore> {
        const narrativeStore: NarrativeStore = {
          read: () => Promise.resolve([]),
          append: (e: NarrativeEntry) => Promise.resolve(e),
          search: () => Promise.resolve([]),
          forget: () => Promise.resolve(),
          render: () => Promise.reject(new Error("store unavailable")),
        };
        return Promise.resolve(narrativeStore);
      },
      list: () => Promise.resolve(stores),
      bootstrap: () => Promise.resolve(""),
      history: () => Promise.resolve([]),
      rollback: () => Promise.resolve(),
    };
    await expect(buildBootstrap(adapter, "ws-1", "agent-1")).rejects.toThrow("store unavailable");
  });
});

// ── seedMemories ──────────────────────────────────────────────────────────────

describe("seedMemories", () => {
  it("calls ensureRoot for narrative and no-strategy entries, skips kv", async () => {
    const calls: Array<{ workspaceId: string; name: string }> = [];
    const adapter = {
      ensureRoot: (workspaceId: string, name: string) => {
        calls.push({ workspaceId, name });
        return Promise.resolve();
      },
    };

    await seedMemories(adapter, "ws-1", [
      { name: "notes", strategy: "narrative" },
      { name: "cache", strategy: "kv" },
      { name: "scratch" },
    ]);

    expect(calls).toEqual([
      { workspaceId: "ws-1", name: "notes" },
      { workspaceId: "ws-1", name: "scratch" },
    ]);
  });

  it("skips retrieval and dedup strategies", async () => {
    const calls: Array<{ workspaceId: string; name: string }> = [];
    const adapter = {
      ensureRoot: (workspaceId: string, name: string) => {
        calls.push({ workspaceId, name });
        return Promise.resolve();
      },
    };

    await seedMemories(adapter, "ws-1", [
      { name: "docs", strategy: "retrieval" },
      { name: "seen", strategy: "dedup" },
    ]);

    expect(calls).toEqual([]);
  });

  it("makes no calls for empty entries array", async () => {
    const calls: string[] = [];
    const adapter = {
      ensureRoot: (_workspaceId: string, name: string) => {
        calls.push(name);
        return Promise.resolve();
      },
    };

    await seedMemories(adapter, "ws-1", []);
    expect(calls).toEqual([]);
  });
});
