import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocBatch } from "../../../memory-adapter.ts";
import { SqliteRetrievalCorpus } from "../SqliteRetrievalCorpus.ts";

function makeCorpus(
  overrides: {
    embedFn?: (text: string) => Promise<number[]>;
    chunkFn?: (text: string) => string[];
  } = {},
): SqliteRetrievalCorpus {
  return new SqliteRetrievalCorpus({ dbPath: ":memory:", vectorDimension: 3, ...overrides });
}

function simpleEmbedFn(text: string): Promise<number[]> {
  const hash = [...text].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return Promise.resolve([Math.sin(hash), Math.cos(hash), Math.sin(hash * 2)]);
}

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
  let corpus: SqliteRetrievalCorpus;

  afterEach(() => {
    corpus?.close();
  });

  describe("ingest", () => {
    it("counts new docs as ingested", async () => {
      corpus = makeCorpus();
      const result = await corpus.ingest(sampleDocs);
      expect(result.ingested).toBe(3);
      expect(result.skipped).toBe(0);
    });

    it("counts duplicate ids as skipped", async () => {
      corpus = makeCorpus();
      await corpus.ingest(sampleDocs);
      const result = await corpus.ingest({
        docs: [
          { id: "d1", text: "different text" },
          { id: "d4", text: "brand new doc" },
        ],
      });
      expect(result.ingested).toBe(1);
      expect(result.skipped).toBe(1);
    });
  });

  describe("query", () => {
    it("returns ingested docs ordered by score descending", async () => {
      corpus = makeCorpus({ embedFn: simpleEmbedFn });
      await corpus.ingest(sampleDocs);
      const hits = await corpus.query({ text: "TypeScript runtime", topK: 3 });
      expect(hits.length).toBeGreaterThan(0);
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i - 1]?.score).toBeGreaterThanOrEqual(hits[i]?.score ?? 0);
      }
    });
  });

  describe("stats", () => {
    it("reflects ingested docs", async () => {
      corpus = makeCorpus();
      await corpus.ingest(sampleDocs);
      const s = await corpus.stats();
      expect(s.count).toBe(3);
      expect(s.sizeBytes).toBeGreaterThan(0);
    });
  });

  describe("reset", () => {
    it("clears all docs so stats returns zero and query returns empty", async () => {
      corpus = makeCorpus({ embedFn: simpleEmbedFn });
      await corpus.ingest(sampleDocs);
      await corpus.reset();
      const s = await corpus.stats();
      expect(s.count).toBe(0);
      const hits = await corpus.query({ text: "anything" });
      expect(hits).toEqual([]);
    });
  });

  describe("topK", () => {
    it("respects q.topK limit", async () => {
      corpus = makeCorpus({ embedFn: simpleEmbedFn });
      await corpus.ingest(sampleDocs);
      const hits = await corpus.query({ text: "fox", topK: 1 });
      expect(hits.length).toBe(1);
    });
  });

  describe("metadata filter", () => {
    it("excludes non-matching docs", async () => {
      corpus = makeCorpus({ embedFn: simpleEmbedFn });
      await corpus.ingest(sampleDocs);
      const hits = await corpus.query(
        { text: "TypeScript", topK: 10 },
        { filter: { topic: "programming" } },
      );
      for (const hit of hits) {
        expect(hit.metadata?.topic).toBe("programming");
      }
      expect(hits.length).toBe(2);
    });
  });

  describe("custom embedFn", () => {
    it("is called for each ingested chunk and for query vectors", async () => {
      const embedSpy = vi.fn<(text: string) => Promise<number[]>>(simpleEmbedFn);
      corpus = makeCorpus({ embedFn: embedSpy });

      await corpus.ingest({
        docs: [
          { id: "e1", text: "chunk one" },
          { id: "e2", text: "chunk two" },
        ],
      });

      expect(embedSpy).toHaveBeenCalledTimes(2);
      expect(embedSpy).toHaveBeenCalledWith("chunk one");
      expect(embedSpy).toHaveBeenCalledWith("chunk two");

      embedSpy.mockClear();
      await corpus.query({ text: "search query" });
      expect(embedSpy).toHaveBeenCalledTimes(1);
      expect(embedSpy).toHaveBeenCalledWith("search query");
    });
  });
});
