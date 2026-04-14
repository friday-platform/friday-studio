import { describe, expect, it } from "vitest";
import type {
  CorpusOf,
  DedupCorpus,
  KVCorpus,
  MemoryAdapter,
  NarrativeCorpus,
  RetrievalCorpus,
} from "../memory-adapter.ts";

describe("CorpusOf conditional type narrowing", () => {
  it("CorpusOf<'narrative'> resolves to NarrativeCorpus", () => {
    type Result = CorpusOf<"narrative">;
    const check: Result extends NarrativeCorpus ? true : false = true;
    expect(check).toBe(true);
  });

  it("CorpusOf<'retrieval'> resolves to RetrievalCorpus", () => {
    type Result = CorpusOf<"retrieval">;
    const check: Result extends RetrievalCorpus ? true : false = true;
    expect(check).toBe(true);
  });

  it("CorpusOf<'dedup'> resolves to DedupCorpus", () => {
    type Result = CorpusOf<"dedup">;
    const check: Result extends DedupCorpus ? true : false = true;
    expect(check).toBe(true);
  });

  it("CorpusOf<'kv'> resolves to KVCorpus", () => {
    type Result = CorpusOf<"kv">;
    const check: Result extends KVCorpus ? true : false = true;
    expect(check).toBe(true);
  });

  it("MemoryAdapter.corpus returns narrowed type", () => {
    const mockAdapter: MemoryAdapter = {
      corpus: () => Promise.resolve({} as never),
      list: () => Promise.resolve([]),
      bootstrap: () => Promise.resolve(""),
      history: () => Promise.resolve([]),
      rollback: () => Promise.resolve(),
    };

    const promise = mockAdapter.corpus("ws-1", "dedup-corpus", "dedup");
    type Returned = Awaited<typeof promise>;
    const check: Returned extends DedupCorpus ? true : false = true;
    expect(check).toBe(true);
  });
});
