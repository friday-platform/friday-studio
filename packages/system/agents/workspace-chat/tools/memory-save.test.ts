import type { Logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

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
  // stub-per-test + unstub-per-test prevents this fetch mock from leaking
  // into sibling test files when vitest schedules multiple suites in the
  // same worker (see agent-registry-tools.test.ts for the same pattern).
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("save_memory_entry", () => {
  it("returns tool object with save_memory_entry, delete_memory_entry", () => {
    const tools = createMemorySaveTool("ws-1", logger);
    expect(tools).toHaveProperty("save_memory_entry");
    expect(tools).toHaveProperty("delete_memory_entry");
  });

  it("POSTs to correct workspaceId + memoryName URL", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const { save_memory_entry } = createMemorySaveTool("al-dente_vanilla", logger);
    await save_memory_entry!.execute!({ memoryName: "notes", text: "Ken won 45/40" }, OPTS);

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/memory/al-dente_vanilla/narrative/notes");
  });

  it("includes metadata when provided", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const { save_memory_entry } = createMemorySaveTool("ws-1", logger);
    await save_memory_entry!.execute!(
      { memoryName: "notes", text: "hello", metadata: { kind: "note" } },
      OPTS,
    );

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { metadata: { kind?: string } };
    expect(body.metadata.kind).toBe("note");
  });

  it("returns error on HTTP failure", async () => {
    mockFetch.mockResolvedValueOnce(new Response("error", { status: 500 }));
    const { save_memory_entry } = createMemorySaveTool("ws-1", logger);
    const result = await save_memory_entry!.execute!({ memoryName: "notes", text: "x" }, OPTS);
    expect(result).toHaveProperty("error");
  });

  it("returns error on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { save_memory_entry } = createMemorySaveTool("ws-1", logger);
    const result = await save_memory_entry!.execute!({ memoryName: "notes", text: "x" }, OPTS);
    expect(result).toHaveProperty("error");
  });
});

describe("delete_memory_entry", () => {
  it("sends DELETE to correct URL", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const { delete_memory_entry } = createMemorySaveTool("al-dente_vanilla", logger);
    const result = await delete_memory_entry!.execute!(
      { memoryName: "notes", entryId: "e123" },
      OPTS,
    );

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/memory/al-dente_vanilla/narrative/notes/e123");
    expect(opts.method).toBe("DELETE");
    expect(result).toHaveProperty("removed", true);
  });

  it("returns error on HTTP failure", async () => {
    mockFetch.mockResolvedValueOnce(new Response("error", { status: 500 }));
    const { delete_memory_entry } = createMemorySaveTool("ws-1", logger);
    const result = await delete_memory_entry!.execute!(
      { memoryName: "notes", entryId: "e1" },
      OPTS,
    );
    expect(result).toHaveProperty("error");
  });

  it("returns error on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { delete_memory_entry } = createMemorySaveTool("ws-1", logger);
    const result = await delete_memory_entry!.execute!(
      { memoryName: "notes", entryId: "e1" },
      OPTS,
    );
    expect(result).toHaveProperty("error");
  });
});
