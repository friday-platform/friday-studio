/**
 * Phase 6.B — promotion-by-reference scan helper.
 *
 * Verifies that {@link hasPromotionSignal} detects each signal source
 * documented in the plan (memory entry text contains the artifact id;
 * aiSummary key-detail URL references the id) and stays quiet when
 * neither is present. The test fakes the memory adapter and the
 * aiSummary provider — both have stable contracts; exercising the
 * JetStream paths is covered separately by the underlying adapter
 * suites.
 */

import type { MemoryAdapter, NarrativeEntry, NarrativeStore } from "@atlas/agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { hasPromotionSignal } from "./reference-scan.ts";

class InMemoryNarrativeStore implements NarrativeStore {
  entries: NarrativeEntry[] = [];

  append(entry: NarrativeEntry): Promise<NarrativeEntry> {
    this.entries.push(entry);
    return Promise.resolve(entry);
  }

  read(): Promise<NarrativeEntry[]> {
    return Promise.resolve(this.entries);
  }

  search(): Promise<NarrativeEntry[]> {
    return Promise.resolve(this.entries);
  }

  forget(): Promise<void> {
    return Promise.resolve();
  }

  render(): Promise<string> {
    return Promise.resolve("");
  }
}

function makeMemoryAdapter(stores: Record<string, InMemoryNarrativeStore>): MemoryAdapter {
  return {
    store(_workspaceId: string, name: string): Promise<NarrativeStore> {
      const s = stores[name];
      if (!s) return Promise.reject(new Error(`unknown store ${name}`));
      return Promise.resolve(s);
    },
    list: () => Promise.resolve([]),
    bootstrap: () => Promise.resolve(""),
    history: () => Promise.resolve([]),
    rollback: () => Promise.resolve(),
  };
}

describe("hasPromotionSignal — memory text", () => {
  it("returns true when a memory entry text contains the artifact id", async () => {
    const artifactId = "art_abc_123";
    const notes = new InMemoryNarrativeStore();
    notes.entries = [
      {
        id: "ent-1",
        text: `kept reference to ${artifactId} for later`,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const adapter = makeMemoryAdapter({ notes });

    const result = await hasPromotionSignal(artifactId, "ws-x", {
      memoryAdapter: adapter,
      memoryStoreNames: ["notes"],
    });

    expect(result).toBe(true);
  });

  it("returns false when no memory entry mentions the artifact id", async () => {
    const notes = new InMemoryNarrativeStore();
    notes.entries = [{ id: "e", text: "unrelated note", createdAt: "2026-01-01T00:00:00.000Z" }];
    const adapter = makeMemoryAdapter({ notes });

    const result = await hasPromotionSignal("art_xyz", "ws-x", {
      memoryAdapter: adapter,
      memoryStoreNames: ["notes"],
    });

    expect(result).toBe(false);
  });

  it("walks all configured stores until a match is found", async () => {
    const artifactId = "art_in_second_store";
    const first = new InMemoryNarrativeStore();
    first.entries = [{ id: "e1", text: "nothing here", createdAt: "2026-01-01T00:00:00.000Z" }];
    const second = new InMemoryNarrativeStore();
    second.entries = [
      { id: "e2", text: `mentions ${artifactId}`, createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    const adapter = makeMemoryAdapter({ first, second });

    const result = await hasPromotionSignal(artifactId, "ws-x", {
      memoryAdapter: adapter,
      memoryStoreNames: ["first", "second"],
    });

    expect(result).toBe(true);
  });

  it("isolates per-store failures and continues scanning", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const artifactId = "art_fallback";
    const good = new InMemoryNarrativeStore();
    good.entries = [
      { id: "e", text: `links ${artifactId}`, createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    const adapter: MemoryAdapter = {
      store(_ws: string, name: string): Promise<NarrativeStore> {
        if (name === "broken") return Promise.reject(new Error("store unavailable"));
        return Promise.resolve(good);
      },
      list: () => Promise.resolve([]),
      bootstrap: () => Promise.resolve(""),
      history: () => Promise.resolve([]),
      rollback: () => Promise.resolve(),
    };

    const result = await hasPromotionSignal(artifactId, "ws-x", {
      memoryAdapter: adapter,
      memoryStoreNames: ["broken", "good"],
    });

    expect(result).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("hasPromotionSignal — aiSummary URL", () => {
  it("returns true when an aiSummary keyDetail URL references the artifact id", async () => {
    const artifactId = "art_in_summary";
    const result = await hasPromotionSignal(artifactId, "ws-x", {
      memoryStoreNames: [],
      aiSummary: () =>
        Promise.resolve([
          { url: "https://example.com/other" },
          { url: `/artifacts/${artifactId}` },
        ]),
    });
    expect(result).toBe(true);
  });

  it("returns false when no aiSummary URL contains the artifact id", async () => {
    const result = await hasPromotionSignal("art_xyz", "ws-x", {
      memoryStoreNames: [],
      aiSummary: () => Promise.resolve([{ url: "https://example.com/other" }]),
    });
    expect(result).toBe(false);
  });

  it("ignores aiSummary entries without a url", async () => {
    const result = await hasPromotionSignal("art_xyz", "ws-x", {
      memoryStoreNames: [],
      aiSummary: () => Promise.resolve([{}, { url: undefined }]),
    });
    expect(result).toBe(false);
  });
});

describe("hasPromotionSignal — combined paths", () => {
  it("returns false when no memory adapter, no stores, and no aiSummary provider", async () => {
    const result = await hasPromotionSignal("art_x", "ws-x", { memoryStoreNames: [] });
    expect(result).toBe(false);
  });

  it("memory match short-circuits before aiSummary scan", async () => {
    const artifactId = "art_short_circuit";
    const notes = new InMemoryNarrativeStore();
    notes.entries = [
      { id: "e", text: `mentions ${artifactId}`, createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    const adapter = makeMemoryAdapter({ notes });
    const aiSummary = vi.fn(() => Promise.resolve([]));

    const result = await hasPromotionSignal(artifactId, "ws-x", {
      memoryAdapter: adapter,
      memoryStoreNames: ["notes"],
      aiSummary,
    });

    expect(result).toBe(true);
    expect(aiSummary).not.toHaveBeenCalled();
  });
});
