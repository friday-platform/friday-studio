import type { DedupCorpus, MemoryAdapter } from "@atlas/agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { createProcessedTicketStore } from "../store.ts";

function makeMockCorpus(): DedupCorpus {
  return {
    append: vi
      .fn<(ns: string, entry: Record<string, unknown>, ttl?: number) => Promise<void>>()
      .mockResolvedValue(undefined),
    filter: vi
      .fn<(ns: string, field: string, values: unknown[]) => Promise<unknown[]>>()
      .mockResolvedValue([]),
    clear: vi.fn<(ns: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}

function makeMockAdapter(corpus: DedupCorpus): MemoryAdapter {
  return {
    corpus: vi.fn().mockResolvedValue(corpus),
    list: vi.fn().mockResolvedValue([]),
    bootstrap: vi.fn().mockResolvedValue(""),
    history: vi.fn().mockResolvedValue([]),
    rollback: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ProcessedTicketStore", () => {
  it("calls DedupCorpus.append for each ticket on recordProcessed", async () => {
    const corpus = makeMockCorpus();
    const adapter = makeMockAdapter(corpus);
    const store = await createProcessedTicketStore(adapter, "ws-1");

    await store.recordProcessed(["ticket-a", "ticket-b", "ticket-c"]);

    expect(corpus.append).toHaveBeenCalledTimes(3);
    expect(corpus.append).toHaveBeenCalledWith("tickets", { ticketId: "ticket-a" }, undefined);
    expect(corpus.append).toHaveBeenCalledWith("tickets", { ticketId: "ticket-b" }, undefined);
    expect(corpus.append).toHaveBeenCalledWith("tickets", { ticketId: "ticket-c" }, undefined);
  });

  it("passes ttlHours through to DedupCorpus.append", async () => {
    const corpus = makeMockCorpus();
    const adapter = makeMockAdapter(corpus);
    const store = await createProcessedTicketStore(adapter, "ws-1");

    await store.recordProcessed(["ticket-x"], 24);

    expect(corpus.append).toHaveBeenCalledWith("tickets", { ticketId: "ticket-x" }, 24);
  });

  it("calls DedupCorpus.filter and returns unseen IDs on filterNew", async () => {
    const corpus = makeMockCorpus();
    vi.mocked(corpus.filter).mockResolvedValue(["ticket-b", "ticket-d"]);
    const adapter = makeMockAdapter(corpus);
    const store = await createProcessedTicketStore(adapter, "ws-1");

    const result = await store.filterNew(["ticket-a", "ticket-b", "ticket-c", "ticket-d"]);

    expect(corpus.filter).toHaveBeenCalledWith("tickets", "ticketId", [
      "ticket-a",
      "ticket-b",
      "ticket-c",
      "ticket-d",
    ]);
    expect(result).toEqual(["ticket-b", "ticket-d"]);
  });

  it("returns empty array when all IDs are already processed", async () => {
    const corpus = makeMockCorpus();
    vi.mocked(corpus.filter).mockResolvedValue([]);
    const adapter = makeMockAdapter(corpus);
    const store = await createProcessedTicketStore(adapter, "ws-1");

    const result = await store.filterNew(["ticket-a"]);

    expect(result).toEqual([]);
  });

  it("calls DedupCorpus.clear on clear", async () => {
    const corpus = makeMockCorpus();
    const adapter = makeMockAdapter(corpus);
    const store = await createProcessedTicketStore(adapter, "ws-1");

    await store.clear();

    expect(corpus.clear).toHaveBeenCalledWith("tickets");
  });

  it("obtains corpus via MemoryAdapter.corpus with correct args", async () => {
    const corpus = makeMockCorpus();
    const adapter = makeMockAdapter(corpus);
    await createProcessedTicketStore(adapter, "workspace-42");

    expect(adapter.corpus).toHaveBeenCalledWith("workspace-42", "processed-tickets", "dedup");
  });
});
