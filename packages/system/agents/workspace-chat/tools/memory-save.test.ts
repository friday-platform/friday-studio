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

beforeEach(() => {
  mockFetch.mockReset();
});

describe("createMemorySaveTool", () => {
  it("returns object with memory_save key", () => {
    const tools = createMemorySaveTool("ws-1", logger);
    expect(tools).toHaveProperty("memory_save");
    expect(tools.memory_save).toBeDefined();
  });

  it("sends POST with correct body and metadata type", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "abc", text: "User's name is Ken" }), { status: 200 }),
    );

    const tools = createMemorySaveTool("ws-1", logger);
    const memorySave = tools.memory_save;
    if (!memorySave) throw new Error("memory_save tool not defined");
    const executeFn = memorySave.execute;
    if (!executeFn) throw new Error("execute not defined");

    const result = await executeFn(
      { text: "User's name is Ken", type: "user-name" },
      { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal },
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/memory/ws-1/narrative/user-profile");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string) as {
      text: string;
      id: string;
      metadata: { type: string };
    };
    expect(body.text).toBe("User's name is Ken");
    expect(body.id).toBeTruthy();
    expect(body.metadata).toEqual({ type: "user-name" });
    expect(result).toHaveProperty("saved", true);
  });

  it("sends POST without metadata when type is omitted", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const tools = createMemorySaveTool("ws-1", logger);
    const memorySave = tools.memory_save;
    if (!memorySave) throw new Error("memory_save tool not defined");
    const executeFn = memorySave.execute;
    if (!executeFn) throw new Error("execute not defined");

    await executeFn(
      { text: "User prefers dark mode" },
      { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal },
    );

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { metadata?: unknown };
    expect(body.metadata).toBeUndefined();
  });

  it("returns error on daemon API failure", async () => {
    mockFetch.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

    const tools = createMemorySaveTool("ws-1", logger);
    const memorySave = tools.memory_save;
    if (!memorySave) throw new Error("memory_save tool not defined");
    const executeFn = memorySave.execute;
    if (!executeFn) throw new Error("execute not defined");

    const result = await executeFn(
      { text: "User's name is Ken", type: "user-name" },
      { toolCallId: "tc-3", messages: [], abortSignal: new AbortController().signal },
    );

    expect(result).toHaveProperty("error");
  });

  it("returns error on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const tools = createMemorySaveTool("ws-1", logger);
    const memorySave = tools.memory_save;
    if (!memorySave) throw new Error("memory_save tool not defined");
    const executeFn = memorySave.execute;
    if (!executeFn) throw new Error("execute not defined");

    const result = await executeFn(
      { text: "test" },
      { toolCallId: "tc-4", messages: [], abortSignal: new AbortController().signal },
    );

    expect(result).toHaveProperty("error");
  });
});
