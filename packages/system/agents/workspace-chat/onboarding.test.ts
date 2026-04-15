import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.stubGlobal("fetch", mockFetch);

vi.mock("@atlas/oapi-client", () => ({ getAtlasDaemonUrl: () => "http://localhost:3000" }));

import { buildOnboardingClause, checkOnboardingState, createMemorySaveTool } from "./onboarding.ts";

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

describe("checkOnboardingState", () => {
  it("returns needsOnboarding=true when daemon returns empty array", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const state = await checkOnboardingState("ws-1", logger);

    expect(state).toEqual({ needsOnboarding: true, declined: false });
  });

  it("returns needsOnboarding=false and userName when name entry exists", async () => {
    const entries = [{ id: "e1", text: "User's name is Ken", createdAt: "2026-01-01T00:00:00Z" }];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(entries), { status: 200 }));

    const state = await checkOnboardingState("ws-1", logger);

    expect(state).toEqual({ needsOnboarding: false, userName: "Ken", declined: false });
  });

  it("returns needsOnboarding=false and declined=true when decline entry exists", async () => {
    const entries = [
      { id: "e1", text: "User declined to share their name", createdAt: "2026-01-01T00:00:00Z" },
    ];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(entries), { status: 200 }));

    const state = await checkOnboardingState("ws-1", logger);

    expect(state).toEqual({ needsOnboarding: false, declined: true });
  });

  it("returns needsOnboarding=true when entries exist but none match name or decline", async () => {
    const entries = [
      { id: "e1", text: "User prefers dark mode", createdAt: "2026-01-01T00:00:00Z" },
      { id: "e2", text: "User works in engineering", createdAt: "2026-01-01T00:00:00Z" },
    ];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(entries), { status: 200 }));

    const state = await checkOnboardingState("ws-1", logger);

    expect(state).toEqual({ needsOnboarding: true, declined: false });
  });

  it("returns needsOnboarding=false on HTTP fetch error (graceful degradation)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const state = await checkOnboardingState("ws-1", logger);

    expect(state).toEqual({ needsOnboarding: false, declined: false });
  });

  it("returns needsOnboarding=false on non-200 HTTP status", async () => {
    mockFetch.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

    const state = await checkOnboardingState("ws-1", logger);

    expect(state).toEqual({ needsOnboarding: false, declined: false });
  });
});

describe("buildOnboardingClause", () => {
  it("returns string containing <onboarding> XML tag and memory_save reference", () => {
    const clause = buildOnboardingClause();

    expect(clause).toContain("<onboarding>");
    expect(clause).toContain("</onboarding>");
    expect(clause).toContain("memory_save");
    expect(clause).toContain("User's name is");
    expect(clause).toContain("User declined");
  });
});

describe("createMemorySaveTool", () => {
  it("returns object with memory_save key", () => {
    const tools = createMemorySaveTool("ws-1", logger);

    expect(tools).toHaveProperty("memory_save");
    expect(tools.memory_save).toBeDefined();
  });

  it("memory_save tool execute calls POST with correct body", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "abc",
          text: "User's name is Ken",
          createdAt: "2026-01-01T00:00:00Z",
        }),
        { status: 200 },
      ),
    );

    const tools = createMemorySaveTool("ws-1", logger);
    const memorySave = tools.memory_save;
    if (!memorySave) throw new Error("memory_save tool not defined");
    const executeFn = memorySave.execute;

    if (!executeFn) throw new Error("execute not defined");
    const result = await executeFn(
      { text: "User's name is Ken" },
      { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal },
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/memory/ws-1/narrative/user-profile");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string) as { text: string };
    expect(body.text).toBe("User's name is Ken");
    expect(result).toHaveProperty("saved", true);
  });

  it("memory_save tool returns error on daemon API failure", async () => {
    mockFetch.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

    const tools = createMemorySaveTool("ws-1", logger);
    const memorySave = tools.memory_save;
    if (!memorySave) throw new Error("memory_save tool not defined");
    const executeFn = memorySave.execute;

    if (!executeFn) throw new Error("execute not defined");
    const result = await executeFn(
      { text: "User's name is Ken" },
      { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal },
    );

    expect(result).toHaveProperty("error");
  });
});
