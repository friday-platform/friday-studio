import type {
  CorpusKind,
  CorpusMetadata,
  CorpusOf,
  MemoryAdapter,
  NarrativeCorpus,
  NarrativeEntry,
} from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";
import type { MountConfig, RenderedMount } from "./bootstrap.ts";
import {
  applyFilter,
  buildBootstrapBlock,
  DEFAULT_MOUNT_MAX_BYTES,
  DEFAULT_TOTAL_MAX_BYTES,
  renderMounts,
  resolveBootstrap,
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
    const result = truncateToBytes(entries, 600);
    expect(result.length).toBeLessThan(3);
    expect(result.length).toBeGreaterThan(0);
  });

  it("never truncates mid-entry", () => {
    const entries = [entry({ text: "short" }), entry({ text: "x".repeat(1000) })];
    const result = truncateToBytes(entries, 100);
    for (const e of result) {
      expect(e.text).toBe("short");
    }
  });

  it("returns all entries when total is under cap", () => {
    const entries = [entry({ text: "short" }), entry({ text: "also short" })];
    const result = truncateToBytes(entries, DEFAULT_MOUNT_MAX_BYTES);
    expect(result).toHaveLength(2);
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

// ── renderMounts ────────────────────────────────────────────────────────────

describe("renderMounts", () => {
  it("produces one ## section per mount with bullet entries", () => {
    const mounts: RenderedMount[] = [
      {
        name: "tasks",
        entries: [entry({ text: "Task A" }), entry({ text: "Task B" })],
        bytesUsed: 100,
      },
      { name: "notes", entries: [entry({ text: "Note 1" })], bytesUsed: 50 },
    ];
    const result = renderMounts(mounts);
    expect(result).toContain("## tasks");
    expect(result).toContain("- Task A");
    expect(result).toContain("- Task B");
    expect(result).toContain("## notes");
    expect(result).toContain("- Note 1");
    const sectionCount = (result.match(/^## /gm) ?? []).length;
    expect(sectionCount).toBe(2);
  });

  it("omits mounts with zero entries after filtering", () => {
    const mounts: RenderedMount[] = [
      { name: "populated", entries: [entry({ text: "visible" })], bytesUsed: 50 },
      { name: "empty", entries: [], bytesUsed: 0 },
    ];
    const result = renderMounts(mounts);
    expect(result).toContain("## populated");
    expect(result).not.toContain("## empty");
  });
});

// ── buildBootstrapBlock ─────────────────────────────────────────────────────

// TS cannot narrow conditional CorpusOf<K> from runtime check (microsoft/TypeScript#33014)
function mockAdapter(corpora: Record<string, NarrativeEntry[]>): MemoryAdapter {
  return {
    corpus<K extends CorpusKind>(_wid: string, name: string, _kind: K): Promise<CorpusOf<K>> {
      const data = corpora[name] ?? [];
      const narrativeCorpus: NarrativeCorpus = {
        read: () => Promise.resolve(data),
        append: (e: NarrativeEntry) => Promise.resolve(e),
        search: () => Promise.resolve([]),
        forget: () => Promise.resolve(),
        render: () => Promise.resolve(data.map((e) => e.text).join("\n")),
      };
      const result: unknown = narrativeCorpus;
      return Promise.resolve(result as CorpusOf<K>);
    },
    list: () => Promise.resolve([]),
    bootstrap: () => Promise.resolve(""),
    history: () => Promise.resolve([]),
    rollback: () => Promise.resolve(),
  };
}

describe("buildBootstrapBlock", () => {
  it("total output is capped at DEFAULT_TOTAL_MAX_BYTES (32 KB)", async () => {
    const bigText = "x".repeat(2000);
    const bigEntries = Array.from({ length: 20 }, (_, i) => entry({ text: `${bigText}-${i}` }));

    const adapter = mockAdapter({ c1: bigEntries, c2: bigEntries, c3: bigEntries });

    const mounts: MountConfig[] = [
      { corpus: "c1", kind: "narrative", bootstrap: { maxBytes: 20000 } },
      { corpus: "c2", kind: "narrative", bootstrap: { maxBytes: 20000 } },
      { corpus: "c3", kind: "narrative", bootstrap: { maxBytes: 20000 } },
    ];

    const result = await buildBootstrapBlock(adapter, "ws-1", "agent-1", mounts, {
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

    const adapter = mockAdapter({ corpus1: entries });

    const smallCap: MountConfig[] = [
      { corpus: "corpus1", kind: "narrative", bootstrap: { maxBytes: 256 } },
    ];
    const defaultCap: MountConfig[] = [{ corpus: "corpus1", kind: "narrative" }];

    const smallResult = await buildBootstrapBlock(adapter, "ws-1", "agent-1", smallCap);
    const defaultResult = await buildBootstrapBlock(adapter, "ws-1", "agent-1", defaultCap);

    const smallBullets = smallResult.split("\n").filter((l) => l.startsWith("- "));
    const defaultBullets = defaultResult.split("\n").filter((l) => l.startsWith("- "));
    expect(smallBullets.length).toBeLessThan(defaultBullets.length);
  });

  it("per-mount cap falls back to DEFAULT_MOUNT_MAX_BYTES (8 KB) when not configured", async () => {
    const entries = Array.from({ length: 200 }, (_, i) =>
      entry({ text: `Entry ${i} ${"padding ".repeat(20)}`, metadata: { priority: 200 - i } }),
    );

    const adapter = mockAdapter({ corpus1: entries });
    const mounts: MountConfig[] = [{ corpus: "corpus1", kind: "narrative" }];

    const result = await buildBootstrapBlock(adapter, "ws-1", "agent-1", mounts);
    const bullets = result.split("\n").filter((l) => l.startsWith("- "));
    const encoder = new TextEncoder();
    const bulletBytes = encoder.encode(bullets.map((b) => b + "\n").join("")).byteLength;
    expect(bulletBytes).toBeLessThanOrEqual(DEFAULT_MOUNT_MAX_BYTES);
  });

  it("returns empty string when all mounts have zero filtered entries", async () => {
    const adapter = mockAdapter({
      empty: [entry({ text: "done item", metadata: { status: "done" } })],
    });

    const mounts: MountConfig[] = [
      { corpus: "empty", kind: "narrative", filter: { status: "pending" } },
    ];

    const result = await buildBootstrapBlock(adapter, "ws-1", "agent-1", mounts);
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

    const mounts: MountConfig[] = [
      { corpus: "tasks", kind: "narrative", filter: { status: "pending", priority_min: 90 } },
    ];

    const result = await buildBootstrapBlock(adapter, "ws-1", "agent-1", mounts);
    expect(result).toContain("High-prio pending");
    expect(result).not.toContain("Low-prio pending");
    expect(result).not.toContain("High-prio done");
    expect(result).not.toContain("No metadata");
    expect(result).toContain("## tasks");
  });
});

// ── resolveBootstrap (legacy) ───────────────────────────────────────────────

function mockResolveAdapter(
  corpora: CorpusMetadata[],
  renderResults: Record<string, string>,
): MemoryAdapter {
  return {
    corpus<K extends CorpusKind>(_wid: string, name: string, _kind: K): Promise<CorpusOf<K>> {
      const narrativeCorpus: NarrativeCorpus = {
        read: () => Promise.resolve([]),
        append: (e: NarrativeEntry) => Promise.resolve(e),
        search: () => Promise.resolve([]),
        forget: () => Promise.resolve(),
        render: () => Promise.resolve(renderResults[name] ?? ""),
      };
      const result: unknown = narrativeCorpus;
      return Promise.resolve(result as CorpusOf<K>);
    },
    list: () => Promise.resolve(corpora),
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

  it("returns '' when all corpus.render() calls return whitespace-only strings", async () => {
    const corpora: CorpusMetadata[] = [
      { name: "c1", kind: "narrative", workspaceId: "ws-1" },
      { name: "c2", kind: "narrative", workspaceId: "ws-1" },
    ];
    const adapter = mockResolveAdapter(corpora, { c1: "   ", c2: "\n\t\n" });
    const result = await resolveBootstrap(adapter, "ws-1", "agent-1");
    expect(result).toBe("");
  });

  it("concatenates non-empty renders with default separator", async () => {
    const corpora: CorpusMetadata[] = [
      { name: "c1", kind: "narrative", workspaceId: "ws-1" },
      { name: "c2", kind: "narrative", workspaceId: "ws-1" },
    ];
    const adapter = mockResolveAdapter(corpora, { c1: "Block one", c2: "Block two" });
    const result = await resolveBootstrap(adapter, "ws-1", "agent-1");
    expect(result).toBe("Block one\n\nBlock two");
  });

  it("respects custom separator option", async () => {
    const corpora: CorpusMetadata[] = [
      { name: "c1", kind: "narrative", workspaceId: "ws-1" },
      { name: "c2", kind: "narrative", workspaceId: "ws-1" },
    ];
    const adapter = mockResolveAdapter(corpora, { c1: "AAA", c2: "BBB" });
    const result = await resolveBootstrap(adapter, "ws-1", "agent-1", { separator: "---" });
    expect(result).toBe("AAA---BBB");
  });

  it("skips non-narrative corpora (kind != 'narrative')", async () => {
    const corpora: CorpusMetadata[] = [
      { name: "c-narrative", kind: "narrative", workspaceId: "ws-1" },
      { name: "c-retrieval", kind: "retrieval", workspaceId: "ws-1" },
      { name: "c-kv", kind: "kv", workspaceId: "ws-1" },
      { name: "c-dedup", kind: "dedup", workspaceId: "ws-1" },
    ];
    const adapter = mockResolveAdapter(corpora, {
      "c-narrative": "Narrative content",
      "c-retrieval": "Should not appear",
      "c-kv": "Should not appear",
      "c-dedup": "Should not appear",
    });
    const result = await resolveBootstrap(adapter, "ws-1", "agent-1");
    expect(result).toBe("Narrative content");
  });
});
