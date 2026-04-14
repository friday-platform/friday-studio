import type {
  CorpusKind,
  CorpusMetadata,
  CorpusOf,
  MemoryAdapter,
  NarrativeCorpus,
  NarrativeEntry,
} from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";
import type { MountConfig } from "./bootstrap.ts";
import {
  applyMountFilter,
  buildBootstrapBlock,
  DEFAULT_PER_MOUNT_MAX_BYTES,
  renderMountSection,
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

// ── applyMountFilter ─────────────────────────────────────────────────────────

describe("applyMountFilter", () => {
  it("equality filter on metadata.status", () => {
    const entries = [
      entry({ text: "a", metadata: { status: "pending" } }),
      entry({ text: "b", metadata: { status: "done" } }),
      entry({ text: "c", metadata: { status: "pending" } }),
    ];
    const result = applyMountFilter(entries, { status: "pending" });
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.text)).toEqual(["a", "c"]);
  });

  it("priority_min threshold (inclusive)", () => {
    const entries = [
      entry({ text: "low", metadata: { priority: 50 } }),
      entry({ text: "exact", metadata: { priority: 90 } }),
      entry({ text: "high", metadata: { priority: 95 } }),
    ];
    const result = applyMountFilter(entries, { priority_min: 90 });
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.text)).toEqual(["exact", "high"]);
  });

  it("multiple predicates are ANDed", () => {
    const entries = [
      entry({ text: "match", metadata: { status: "pending", priority: 95 } }),
      entry({ text: "wrong status", metadata: { status: "done", priority: 95 } }),
      entry({ text: "low prio", metadata: { status: "pending", priority: 50 } }),
    ];
    const result = applyMountFilter(entries, { status: "pending", priority_min: 90 });
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("match");
  });

  it("entries missing metadata are excluded when filter has predicates", () => {
    const entries = [
      entry({ text: "no-meta" }),
      entry({ text: "has-meta", metadata: { status: "pending" } }),
    ];
    const result = applyMountFilter(entries, { status: "pending" });
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("has-meta");
  });
});

// ── sortByPriorityDesc ───────────────────────────────────────────────────────

describe("sortByPriorityDesc", () => {
  it("entries with numeric metadata.priority are ordered high→low", () => {
    const entries = [
      entry({ text: "low", metadata: { priority: 10 } }),
      entry({ text: "high", metadata: { priority: 99 } }),
      entry({ text: "mid", metadata: { priority: 50 } }),
    ];
    const sorted = sortByPriorityDesc(entries);
    expect(sorted.map((e) => e.text)).toEqual(["high", "mid", "low"]);
  });

  it("entries missing priority sort after entries with priority (treated as 0)", () => {
    const entries = [
      entry({ text: "no-prio" }),
      entry({ text: "has-prio", metadata: { priority: 5 } }),
      entry({ text: "also-no-prio", metadata: {} }),
    ];
    const sorted = sortByPriorityDesc(entries);
    expect(sorted[0]?.text).toBe("has-prio");
    expect(sorted.slice(1).map((e) => e.text)).toEqual(
      expect.arrayContaining(["no-prio", "also-no-prio"]),
    );
  });
});

// ── truncateToBytes ──────────────────────────────────────────────────────────

describe("truncateToBytes", () => {
  it("entries truncated at per-mount byte cap; omitted count is accurate", () => {
    const longText = "x".repeat(500);
    const entries = [
      entry({ text: longText, createdAt: "2026-04-14T00:00:00Z" }),
      entry({ text: longText, createdAt: "2026-04-14T00:00:00Z" }),
      entry({ text: longText, createdAt: "2026-04-14T00:00:00Z" }),
    ];
    const { kept, omitted } = truncateToBytes(entries, 600);
    expect(kept.length).toBeLessThan(3);
    expect(omitted).toBe(3 - kept.length);
    expect(kept.length + omitted).toBe(3);
  });

  it("no truncation when total size is under cap", () => {
    const entries = [
      entry({ text: "short", createdAt: "2026-04-14T00:00:00Z" }),
      entry({ text: "also short", createdAt: "2026-04-14T00:00:00Z" }),
    ];
    const { kept, omitted } = truncateToBytes(entries, DEFAULT_PER_MOUNT_MAX_BYTES);
    expect(kept).toHaveLength(2);
    expect(omitted).toBe(0);
  });
});

// ── renderMountSection ───────────────────────────────────────────────────────

describe("renderMountSection", () => {
  it("produces markdown h2 header with mount name", () => {
    const result = renderMountSection("Open Tickets", [], 0);
    expect(result).toMatch(/^## Open Tickets/);
  });

  it("each entry rendered as bullet with date and text", () => {
    const entries = [
      entry({
        text: "Ticket #42: Payment gateway timeout",
        createdAt: "2026-04-14T12:00:00Z",
        metadata: { priority: 95 },
      }),
    ];
    const result = renderMountSection("Tickets", entries, 0);
    expect(result).toContain("- [2026-04-14] Ticket #42: Payment gateway timeout (priority: 95)");
  });

  it("omit comment appended only when omitted > 0", () => {
    const entries = [entry({ text: "test" })];
    const withoutOmit = renderMountSection("A", entries, 0);
    expect(withoutOmit).not.toContain("<!-- ");

    const withOmit = renderMountSection("A", entries, 3);
    expect(withOmit).toContain("<!-- 3 entries omitted (cap reached) -->");
  });
});

// ── buildBootstrapBlock ──────────────────────────────────────────────────────

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
  it("integrates filter + sort + cap + render for multiple mounts", async () => {
    const adapter = mockAdapter({
      tickets: [
        entry({
          text: "Ticket A",
          metadata: { status: "pending", priority: 95 },
          createdAt: "2026-04-14T00:00:00Z",
        }),
        entry({
          text: "Ticket B",
          metadata: { status: "done", priority: 80 },
          createdAt: "2026-04-13T00:00:00Z",
        }),
      ],
      logs: [entry({ text: "Log entry 1", createdAt: "2026-04-14T00:00:00Z" })],
    });

    const mounts: MountConfig[] = [
      { name: "Open Tickets", corpus: "tickets", filter: { status: "pending" } },
      { name: "Logs", corpus: "logs" },
    ];

    const result = await buildBootstrapBlock("ws-1", "agent-1", adapter, mounts);
    expect(result).toContain("## Open Tickets");
    expect(result).toContain("Ticket A");
    expect(result).not.toContain("Ticket B");
    expect(result).toContain("## Logs");
    expect(result).toContain("Log entry 1");
  });

  it("total cap of 32 KB enforced across mounts", async () => {
    const bigText = "x".repeat(2000);
    const bigEntries = Array.from({ length: 20 }, (_, i) =>
      entry({ text: `${bigText}-${i}`, createdAt: "2026-04-14T00:00:00Z" }),
    );

    const adapter = mockAdapter({ c1: bigEntries, c2: bigEntries, c3: bigEntries });

    const mounts: MountConfig[] = [
      { name: "Mount1", corpus: "c1", bootstrap: { maxBytes: 20000 } },
      { name: "Mount2", corpus: "c2", bootstrap: { maxBytes: 20000 } },
      { name: "Mount3", corpus: "c3", bootstrap: { maxBytes: 20000 } },
    ];

    const result = await buildBootstrapBlock("ws-1", "agent-1", adapter, mounts, {
      totalMaxBytes: 32768,
    });
    const encoder = new TextEncoder();
    expect(encoder.encode(result).byteLength).toBeLessThanOrEqual(32768);
  });

  it("per-mount bootstrap.maxBytes overrides DEFAULT_PER_MOUNT_MAX_BYTES", async () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      entry({
        text: `Entry ${i} with some text padding to increase size`,
        createdAt: "2026-04-14T00:00:00Z",
        metadata: { priority: 50 - i },
      }),
    );

    const adapter = mockAdapter({ corpus1: entries });

    const smallCap: MountConfig[] = [
      { name: "Small", corpus: "corpus1", bootstrap: { maxBytes: 256 } },
    ];
    const defaultCap: MountConfig[] = [{ name: "Default", corpus: "corpus1" }];

    const smallResult = await buildBootstrapBlock("ws-1", "agent-1", adapter, smallCap);
    const defaultResult = await buildBootstrapBlock("ws-1", "agent-1", adapter, defaultCap);

    const smallBullets = smallResult.split("\n").filter((l) => l.startsWith("- "));
    const defaultBullets = defaultResult.split("\n").filter((l) => l.startsWith("- "));
    expect(smallBullets.length).toBeLessThan(defaultBullets.length);
  });

  it("empty mount (no entries after filter) produces empty section", async () => {
    const adapter = mockAdapter({
      empty: [entry({ text: "done item", metadata: { status: "done" } })],
    });

    const mounts: MountConfig[] = [
      { name: "Empty", corpus: "empty", filter: { status: "pending" } },
    ];

    const result = await buildBootstrapBlock("ws-1", "agent-1", adapter, mounts);
    expect(result).toContain("## Empty");
    expect(result).not.toContain("- [");
  });
});

// ── resolveBootstrap ────────────────────────────────────────────────────────

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
