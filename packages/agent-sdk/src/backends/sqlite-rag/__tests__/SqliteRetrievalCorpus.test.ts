import { Database } from "@db/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocBatch } from "../../../memory-adapter.ts";
import { ChunkerRegistry, DefaultChunker, getChunker } from "../chunker.ts";
import { SqliteRetrievalCorpus } from "../SqliteRetrievalCorpus.ts";

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

describe("SqliteRetrievalCorpus", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("ingest() splits docs into chunks and returns correct IngestResult.ingested count", async () => {
    const corpus = new SqliteRetrievalCorpus(db, "ws1", "test");
    const result = await corpus.ingest(sampleDocs);
    expect(result.ingested).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it("ingest() with duplicate doc id skips re-ingestion and increments IngestResult.skipped", async () => {
    const corpus = new SqliteRetrievalCorpus(db, "ws1", "test");
    await corpus.ingest(sampleDocs);
    const result = await corpus.ingest({
      docs: [
        { id: "d1", text: "different text" },
        { id: "d4", text: "brand new document about TypeScript" },
      ],
    });
    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("query() returns Hit[] sorted by BM25 rank descending", async () => {
    const corpus = new SqliteRetrievalCorpus(db, "ws1", "test");
    await corpus.ingest(sampleDocs);
    const hits = await corpus.query({ text: "TypeScript JavaScript", topK: 10 });
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
    const corpus = new SqliteRetrievalCorpus(db, "ws1", "test");
    await corpus.ingest(sampleDocs);
    const hits = await corpus.query({ text: "TypeScript", topK: 1 });
    expect(hits.length).toBe(1);
  });

  it("query() applies metadata filter from RetrievalOpts.filter as post-filter", async () => {
    const corpus = new SqliteRetrievalCorpus(db, "ws1", "test");
    await corpus.ingest(sampleDocs);
    const hits = await corpus.query(
      { text: "TypeScript runtime", topK: 10 },
      { filter: { topic: "programming" } },
    );
    for (const hit of hits) {
      expect(hit.metadata?.topic).toBe("programming");
    }
    expect(hits.length).toBe(2);
  });

  it("stats() returns correct chunk count and non-zero sizeBytes after ingest", async () => {
    const corpus = new SqliteRetrievalCorpus(db, "ws1", "test");
    await corpus.ingest(sampleDocs);
    const s = await corpus.stats();
    expect(s.count).toBe(3);
    expect(s.sizeBytes).toBeGreaterThan(0);
  });

  it("reset() clears all chunks for the corpus and updates stats to zero", async () => {
    const corpus = new SqliteRetrievalCorpus(db, "ws1", "test");
    await corpus.ingest(sampleDocs);
    await corpus.reset();
    const s = await corpus.stats();
    expect(s.count).toBe(0);
    expect(s.sizeBytes).toBe(0);
  });

  it("reset() does not affect chunks belonging to a different corpus in the same DB", async () => {
    const corpusA = new SqliteRetrievalCorpus(db, "ws1", "corpus-a");
    const corpusB = new SqliteRetrievalCorpus(db, "ws1", "corpus-b");

    await corpusA.ingest(sampleDocs);
    await corpusB.ingest({ docs: [{ id: "b1", text: "Document in corpus B about programming" }] });

    await corpusA.reset();

    const statsA = await corpusA.stats();
    expect(statsA.count).toBe(0);

    const statsB = await corpusB.stats();
    expect(statsB.count).toBe(1);
  });

  it("history entries are appended on ingest() and reset()", async () => {
    const corpus = new SqliteRetrievalCorpus(db, "ws1", "test");
    await corpus.ingest(sampleDocs);
    await corpus.reset();

    const history = corpus.getHistory();
    expect(history.length).toBe(2);

    const resetEntry = history[0];
    expect(resetEntry?.summary).toContain("reset");

    const ingestEntry = history[1];
    expect(ingestEntry?.summary).toContain("Ingested");
    expect(ingestEntry?.corpus).toBe("test");
    expect(ingestEntry?.version).toBeTruthy();
    expect(ingestEntry?.at).toBeTruthy();
  });
});

describe("chunker", () => {
  it("getChunker() falls back to DefaultChunker when opts.chunker is undefined", () => {
    const fn = getChunker(undefined);
    expect(fn).toBe(DefaultChunker);

    const fn2 = getChunker({});
    expect(fn2).toBe(DefaultChunker);
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

  it("DefaultChunker produces chunks with max 512 tokens and 64-token overlap", () => {
    const words = Array.from({ length: 1000 }, (_, i) => `word${i}`);
    const text = words.join(" ");

    const chunks = DefaultChunker(text);

    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const chunkWords = chunk.split(/\s+/).filter((w) => w.length > 0);
      expect(chunkWords.length).toBeLessThanOrEqual(512);
    }

    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const curr = chunks[i];
      if (!prev || !curr) continue;

      const prevWords = prev.split(/\s+/).filter((w) => w.length > 0);
      const currWords = curr.split(/\s+/).filter((w) => w.length > 0);
      const overlapSize = Math.min(64, prevWords.length, currWords.length);
      const prevTail = prevWords.slice(-overlapSize);
      const currHead = currWords.slice(0, overlapSize);
      expect(prevTail).toEqual(currHead);
    }
  });
});
