import { describe, expect, it } from "vitest";
import type {
  DedupStore,
  KVStore,
  MemoryAdapter,
  NarrativeStore,
  RetrievalStore,
  StoreOf,
} from "../memory-adapter.ts";

describe("StoreOf conditional type narrowing", () => {
  it("StoreOf<'narrative'> resolves to NarrativeStore", () => {
    type Result = StoreOf<"narrative">;
    const check: Result extends NarrativeStore ? true : false = true;
    expect(check).toBe(true);
  });

  it("StoreOf<'retrieval'> resolves to RetrievalStore", () => {
    type Result = StoreOf<"retrieval">;
    const check: Result extends RetrievalStore ? true : false = true;
    expect(check).toBe(true);
  });

  it("StoreOf<'dedup'> resolves to DedupStore", () => {
    type Result = StoreOf<"dedup">;
    const check: Result extends DedupStore ? true : false = true;
    expect(check).toBe(true);
  });

  it("StoreOf<'kv'> resolves to KVStore", () => {
    type Result = StoreOf<"kv">;
    const check: Result extends KVStore ? true : false = true;
    expect(check).toBe(true);
  });

  it("MemoryAdapter.store returns narrowed type", () => {
    const mockAdapter: MemoryAdapter = {
      store: () => Promise.resolve({} as never),
      list: () => Promise.resolve([]),
      bootstrap: () => Promise.resolve(""),
      history: () => Promise.resolve([]),
      rollback: () => Promise.resolve(),
    };

    const promise = mockAdapter.store("ws-1", "dedup-store", "dedup");
    type Returned = Awaited<typeof promise>;
    const check: Returned extends DedupStore ? true : false = true;
    expect(check).toBe(true);
  });
});
