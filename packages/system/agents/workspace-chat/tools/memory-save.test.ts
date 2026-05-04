import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.stubGlobal("fetch", mockFetch);
vi.mock("@atlas/oapi-client", () => ({ getAtlasDaemonUrl: () => "http://localhost:3000" }));

import { createMemorySaveTool } from "./memory-save.ts";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

const OPTS = { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal };

beforeEach(() => {
  mockFetch.mockReset();
});

describe("memory_save", () => {
  it("returns tool object with memory_save, memory_read, memory_remove", () => {
    const tools = createMemorySaveTool("ws-1", logger);
    expect(tools).toHaveProperty("memory_save");
    expect(tools).toHaveProperty("memory_read");
    expect(tools).toHaveProperty("memory_remove");
  });

  it("POSTs to correct workspaceId + memoryName URL", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const { memory_save } = createMemorySaveTool("al-dente_vanilla", logger);
    await memory_save!.execute!({ memoryName: "notes", text: "Ken won 45/40" }, OPTS);

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/memory/al-dente_vanilla/narrative/notes");
  });

  it("includes metadata when provided", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const { memory_save } = createMemorySaveTool("ws-1", logger);
    await memory_save!.execute!(
      { memoryName: "notes", text: "hello", metadata: { kind: "note" } },
      OPTS,
    );

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { metadata: unknown };
    expect(body.metadata).toEqual({ kind: "note" });
  });

  it("returns error on HTTP failure", async () => {
    mockFetch.mockResolvedValueOnce(new Response("error", { status: 500 }));
    const { memory_save } = createMemorySaveTool("ws-1", logger);
    const result = await memory_save!.execute!({ memoryName: "notes", text: "x" }, OPTS);
    expect(result).toHaveProperty("error");
  });

  it("returns error on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { memory_save } = createMemorySaveTool("ws-1", logger);
    const result = await memory_save!.execute!({ memoryName: "notes", text: "x" }, OPTS);
    expect(result).toHaveProperty("error");
  });
});

describe("memory_read", () => {
  it("GETs correct URL with since/limit params", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const { memory_read } = createMemorySaveTool("al-dente_vanilla", logger);
    await memory_read!.execute!({ memoryName: "notes", since: "2026-01-01", limit: 10 }, OPTS);

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain("/api/memory/al-dente_vanilla/narrative/notes");
    expect(url).toContain("since=2026-01-01");
    expect(url).toContain("limit=10");
  });

  it("returns ReadResponse envelope with items + provenance", async () => {
    const entries = [{ id: "e1", text: "a", createdAt: "2026-01-01T00:00:00Z" }];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(entries), { status: 200 }));

    const { memory_read } = createMemorySaveTool("ws-1", logger);
    const result = (await memory_read!.execute!({ memoryName: "notes" }, OPTS)) as {
      items?: unknown[];
      provenance?: { source?: string; origin?: string };
    };
    expect(result.items).toEqual(entries);
    expect(result.provenance?.source).toBe("user-authored");
    expect(result.provenance?.origin).toBe("memory:notes");
  });

  it("returns error on HTTP failure", async () => {
    mockFetch.mockResolvedValueOnce(new Response("error", { status: 500 }));
    const { memory_read } = createMemorySaveTool("ws-1", logger);
    const result = await memory_read!.execute!({ memoryName: "notes" }, OPTS);
    expect(result).toHaveProperty("error");
  });

  it("returns error on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { memory_read } = createMemorySaveTool("ws-1", logger);
    const result = await memory_read!.execute!({ memoryName: "notes" }, OPTS);
    expect(result).toHaveProperty("error");
  });
});

describe("memory_remove", () => {
  it("sends DELETE to correct URL", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const { memory_remove } = createMemorySaveTool("al-dente_vanilla", logger);
    const result = await memory_remove!.execute!({ memoryName: "notes", entryId: "e123" }, OPTS);

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/memory/al-dente_vanilla/narrative/notes/e123");
    expect(opts.method).toBe("DELETE");
    expect(result).toHaveProperty("removed", true);
  });

  it("returns error on HTTP failure", async () => {
    mockFetch.mockResolvedValueOnce(new Response("error", { status: 500 }));
    const { memory_remove } = createMemorySaveTool("ws-1", logger);
    const result = await memory_remove!.execute!({ memoryName: "notes", entryId: "e1" }, OPTS);
    expect(result).toHaveProperty("error");
  });

  it("returns error on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { memory_remove } = createMemorySaveTool("ws-1", logger);
    const result = await memory_remove!.execute!({ memoryName: "notes", entryId: "e1" }, OPTS);
    expect(result).toHaveProperty("error");
  });
});
