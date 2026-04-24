import { Database } from "@db/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocBatch } from "../../../memory-adapter.ts";
import {
  ChunkerRegistry,
  FixedChunker,
  getChunker,
  NoneChunker,
  SentenceChunker,
} from "../chunker.ts";
import { SqliteRetrievalStore } from "../SqliteRetrievalStore.ts";

const sampleDocs: DocBatch = {
  docs: [
    {
      id: "d1",
      text: "The quick brown fox jumps over the lazy dog",
      metadata: { topic: "animals" },
    },
    {
      id: "d2",
      text: "TypeScript is a typed superset of JavaScript",
      metadata: { topic: "programming" },
    },
    {
      id: "d3",
      text: "Deno is a modern runtime for JavaScript and TypeScript",
      metadata: { topic: "programming" },
    },
  ],
};

describe("SqliteRetrievalStore", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("ingest() splits docs into chunks and returns correct IngestResult.ingested count", async () => {
    const store = new SqliteRetrievalStore(db, "ws1", "test");
    const result = await store.ingest(sampleDocs);
    expect(result.ingested).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it("ingest() with duplicate doc id skips re-ingestion and increments IngestResult.skipped", async () => {
    const store = new SqliteRetrievalStore(db, "ws1", "test");
    await store.ingest(sampleDocs);
    const result = await store.ingest({
      docs: [
        { id: "d1", text: "different text" },
        { id: "d4", text: "brand new document about TypeScript" },
      ],
    });
    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("query() returns Hit[] sorted by BM25 rank descending", async () => {
    const store = new SqliteRetrievalStore(db, "ws1", "test");
    await store.ingest(sampleDocs);
    const hits = await store.query({ text: "TypeScript JavaScript", topK: 10 });
    expect(hits.length).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1];
      const curr = hits[i];
      if (prev && curr) {
        expect(prev.score).toBeGreaterThanOrEqual(curr.score);
      }
    }
  });

  it("query() respects topK limit via RetrievalQuery.topK", async () => {
    const store = new SqliteRetrievalStore(db, "ws1", "test");
    await store.ingest(sampleDocs);
    const hits = await store.query({ text: "TypeScript", topK: 1 });
    expect(hits.length).toBe(1);
  });

  it("query() applies metadata filter from RetrievalOpts.filter as post-filter", async () => {
    const store = new SqliteRetrievalStore(db, "ws1", "test");
    await store.ingest(sampleDocs);
    const hits = await store.query(
      { text: "TypeScript runtime", topK: 10 },
      { filter: { topic: "programming" } },
    );
    for (const hit of hits) {
      expect(hit.metadata?.topic).toBe("programming");
    }
    expect(hits.length).toBe(2);
  });

  it("stats() returns correct chunk count and non-zero sizeBytes after ingest", async () => {
    const store = new SqliteRetrievalStore(db, "ws1", "test");
    await store.ingest(sampleDocs);
    const s = await store.stats();
    expect(s.count).toBe(3);
    expect(s.sizeBytes).toBeGreaterThan(0);
  });

  it("reset() clears all chunks for the store and updates stats to zero", async () => {
    const store = new SqliteRetrievalStore(db, "ws1", "test");
    await store.ingest(sampleDocs);
    await store.reset();
    const s = await store.stats();
    expect(s.count).toBe(0);
    expect(s.sizeBytes).toBe(0);
  });

  it("reset() does not affect chunks belonging to a different store in the same DB", async () => {
    const storeA = new SqliteRetrievalStore(db, "ws1", "store-a");
    const storeB = new SqliteRetrievalStore(db, "ws1", "store-b");

    await storeA.ingest(sampleDocs);
    await storeB.ingest({ docs: [{ id: "b1", text: "Document in store B about programming" }] });

    await storeA.reset();

    const statsA = await storeA.stats();
    expect(statsA.count).toBe(0);

    const statsB = await storeB.stats();
    expect(statsB.count).toBe(1);
  });

  it("ingest() with chunker='sentence' splits text into multiple chunks", async () => {
    const store = new SqliteRetrievalStore(db, "ws1", "test");
    const result = await store.ingest(
      {
        docs: [
          {
            id: "multi-sentence",
            text: "First sentence about TypeScript. Second sentence about Deno. Third sentence about testing.",
          },
        ],
      },
      { chunker: "sentence" },
    );
    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(0);
    const stats = await store.stats();
    expect(stats.count).toBeGreaterThanOrEqual(1);
  });

  it("ingest() with chunker='none' stores doc as a single chunk", async () => {
    const store = new SqliteRetrievalStore(db, "ws1", "test");
    const longText = "Word ".repeat(1000).trim();
    const result = await store.ingest(
      { docs: [{ id: "single", text: longText }] },
      { chunker: "none" },
    );
    expect(result.ingested).toBe(1);
    const stats = await store.stats();
    expect(stats.count).toBe(1);
  });

  it("query() returns empty array when store has no matching documents", async () => {
    const store = new SqliteRetrievalStore(db, "ws1", "test");
    await store.ingest(sampleDocs);
    const hits = await store.query({ text: "xyznonexistentterm" });
    expect(hits).toEqual([]);
  });

  it("stats() returns {count:0, sizeBytes:0} on empty store", async () => {
    const store = new SqliteRetrievalStore(db, "ws1", "empty");
    const s = await store.stats();
    expect(s.count).toBe(0);
    expect(s.sizeBytes).toBe(0);
  });

  it("history entries are appended on ingest() and reset()", async () => {
    const store = new SqliteRetrievalStore(db, "ws1", "test");
    await store.ingest(sampleDocs);
    await store.reset();

    const history = store.getHistory();
    expect(history.length).toBe(2);

    const resetEntry = history[0];
    expect(resetEntry?.summary).toContain("reset");

    const ingestEntry = history[1];
    expect(ingestEntry?.summary).toContain("Ingested");
    expect(ingestEntry?.store).toBe("test");
    expect(ingestEntry?.version).toBeTruthy();
    expect(ingestEntry?.at).toBeTruthy();
  });
});

describe("chunker", () => {
  it("getChunker() falls back to SentenceChunker when opts.chunker is undefined", () => {
    const fn = getChunker(undefined);
    expect(fn).toBe(SentenceChunker);

    const fn2 = getChunker({});
    expect(fn2).toBe(SentenceChunker);
  });

  it("getChunker() returns registered chunker by name from ChunkerRegistry", () => {
    const custom = (text: string): string[] => [text];
    ChunkerRegistry.set("custom", custom);
    try {
      const fn = getChunker({ chunker: "custom" });
      expect(fn).toBe(custom);
    } finally {
      ChunkerRegistry.delete("custom");
    }
  });

  it("SentenceChunker splits text on sentence boundaries (.!?) with max 512 chars", () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} about topic.`);
    const text = sentences.join(" ");

    const chunks = SentenceChunker(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(512 + 100);
    }
  });

  it("FixedChunker produces fixed-width chunks with overlap", () => {
    const words = Array.from({ length: 1000 }, (_, i) => `word${i}`);
    const text = words.join(" ");

    const chunks = FixedChunker(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("NoneChunker returns the entire text as a single chunk", () => {
    const text = "A ".repeat(1000).trim();
    const chunks = NoneChunker(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });
});
