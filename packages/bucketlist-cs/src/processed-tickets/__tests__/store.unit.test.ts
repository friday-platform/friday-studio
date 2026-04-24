import type { DedupStore, MemoryAdapter } from "@atlas/agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { createProcessedTicketStore } from "../store.ts";

function makeMockStore(): DedupStore {
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

function makeMockAdapter(mockStore: DedupStore): MemoryAdapter {
  return {
    store: vi.fn().mockResolvedValue(mockStore),
    list: vi.fn().mockResolvedValue([]),
    bootstrap: vi.fn().mockResolvedValue(""),
    history: vi.fn().mockResolvedValue([]),
    rollback: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ProcessedTicketStore", () => {
  it("calls DedupStore.append for each ticket on recordProcessed", async () => {
    const mockDedupStore = makeMockStore();
    const adapter = makeMockAdapter(mockDedupStore);
    const store = await createProcessedTicketStore(adapter, "ws-1");

    await store.recordProcessed(["ticket-a", "ticket-b", "ticket-c"]);

    expect(mockDedupStore.append).toHaveBeenCalledTimes(3);
    expect(mockDedupStore.append).toHaveBeenCalledWith(
      "tickets",
      { ticketId: "ticket-a" },
      undefined,
    );
    expect(mockDedupStore.append).toHaveBeenCalledWith(
      "tickets",
      { ticketId: "ticket-b" },
      undefined,
    );
    expect(mockDedupStore.append).toHaveBeenCalledWith(
      "tickets",
      { ticketId: "ticket-c" },
      undefined,
    );
  });

  it("passes ttlHours through to DedupStore.append", async () => {
    const mockDedupStore = makeMockStore();
    const adapter = makeMockAdapter(mockDedupStore);
    const store = await createProcessedTicketStore(adapter, "ws-1");

    await store.recordProcessed(["ticket-x"], 24);

    expect(mockDedupStore.append).toHaveBeenCalledWith("tickets", { ticketId: "ticket-x" }, 24);
  });

  it("calls DedupStore.filter and returns unseen IDs on filterNew", async () => {
    const mockDedupStore = makeMockStore();
    vi.mocked(mockDedupStore.filter).mockResolvedValue(["ticket-b", "ticket-d"]);
    const adapter = makeMockAdapter(mockDedupStore);
    const store = await createProcessedTicketStore(adapter, "ws-1");

    const result = await store.filterNew(["ticket-a", "ticket-b", "ticket-c", "ticket-d"]);

    expect(mockDedupStore.filter).toHaveBeenCalledWith("tickets", "ticketId", [
      "ticket-a",
      "ticket-b",
      "ticket-c",
      "ticket-d",
    ]);
    expect(result).toEqual(["ticket-b", "ticket-d"]);
  });

  it("returns empty array when all IDs are already processed", async () => {
    const mockDedupStore = makeMockStore();
    vi.mocked(mockDedupStore.filter).mockResolvedValue([]);
    const adapter = makeMockAdapter(mockDedupStore);
    const store = await createProcessedTicketStore(adapter, "ws-1");

    const result = await store.filterNew(["ticket-a"]);

    expect(result).toEqual([]);
  });

  it("calls DedupStore.clear on clear", async () => {
    const mockDedupStore = makeMockStore();
    const adapter = makeMockAdapter(mockDedupStore);
    const store = await createProcessedTicketStore(adapter, "ws-1");

    await store.clear();

    expect(mockDedupStore.clear).toHaveBeenCalledWith("tickets");
  });

  it("obtains store via MemoryAdapter.store with correct args", async () => {
    const mockDedupStore = makeMockStore();
    const adapter = makeMockAdapter(mockDedupStore);
    await createProcessedTicketStore(adapter, "workspace-42");

    expect(adapter.store).toHaveBeenCalledWith("workspace-42", "processed-tickets", "dedup");
  });
});
