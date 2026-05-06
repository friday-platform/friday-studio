import type { Logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockFetchWorkspaceDetails, mockParseResult } = vi.hoisted(() => ({
  mockFetchWorkspaceDetails: vi.fn(),
  mockParseResult: vi.fn<() => Promise<{ ok: boolean; data?: unknown; error?: string }>>(),
}));

vi.mock("./workspace-chat.agent.ts", () => ({ fetchWorkspaceDetails: mockFetchWorkspaceDetails }));

vi.mock("@atlas/client/v2", () => ({
  client: { workspace: { ":workspaceId": { config: { $get: () => undefined } } } },
  parseResult: mockParseResult,
}));

import { clearBlock2CacheForTests, getBlock2Inputs, invalidateBlock2 } from "./block2-cache.ts";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

beforeEach(() => {
  clearBlock2CacheForTests();
  mockFetchWorkspaceDetails.mockReset();
  mockParseResult.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const stubDetails = (name: string) => ({
  name,
  description: undefined,
  agents: [],
  jobs: [],
  signals: [],
  artifacts: [],
});

describe("getBlock2Inputs", () => {
  it("fetches and caches the inputs on first call", async () => {
    mockFetchWorkspaceDetails.mockResolvedValueOnce(stubDetails("Personal"));
    mockParseResult.mockResolvedValueOnce({ ok: true, data: { config: { custom: 1 } } });

    const first = await getBlock2Inputs("ws-1", logger);
    expect(first.details.name).toBe("Personal");
    expect(first.config).toEqual({ custom: 1 });
    expect(mockFetchWorkspaceDetails).toHaveBeenCalledOnce();
    expect(mockParseResult).toHaveBeenCalledOnce();
  });

  it("returns the cached value on subsequent calls within TTL", async () => {
    mockFetchWorkspaceDetails.mockResolvedValueOnce(stubDetails("Personal"));
    mockParseResult.mockResolvedValueOnce({ ok: true, data: { config: {} } });

    const first = await getBlock2Inputs("ws-1", logger);
    const second = await getBlock2Inputs("ws-1", logger);

    expect(second).toBe(first);
    expect(mockFetchWorkspaceDetails).toHaveBeenCalledOnce();
    expect(mockParseResult).toHaveBeenCalledOnce();
  });

  it("re-fetches after TTL expires", async () => {
    vi.useFakeTimers();
    mockFetchWorkspaceDetails
      .mockResolvedValueOnce(stubDetails("First"))
      .mockResolvedValueOnce(stubDetails("Second"));
    mockParseResult
      .mockResolvedValueOnce({ ok: true, data: { config: {} } })
      .mockResolvedValueOnce({ ok: true, data: { config: {} } });

    const first = await getBlock2Inputs("ws-1", logger);
    expect(first.details.name).toBe("First");

    vi.advanceTimersByTime(6 * 60 * 1000);

    const second = await getBlock2Inputs("ws-1", logger);
    expect(second.details.name).toBe("Second");
    expect(mockFetchWorkspaceDetails).toHaveBeenCalledTimes(2);
  });

  it("invalidateBlock2 forces re-fetch on next call", async () => {
    mockFetchWorkspaceDetails
      .mockResolvedValueOnce(stubDetails("First"))
      .mockResolvedValueOnce(stubDetails("Second"));
    mockParseResult
      .mockResolvedValueOnce({ ok: true, data: { config: {} } })
      .mockResolvedValueOnce({ ok: true, data: { config: {} } });

    await getBlock2Inputs("ws-1", logger);
    invalidateBlock2("ws-1");
    const after = await getBlock2Inputs("ws-1", logger);
    expect(after.details.name).toBe("Second");
    expect(mockFetchWorkspaceDetails).toHaveBeenCalledTimes(2);
  });

  it("leaves config undefined when the config fetch fails", async () => {
    mockFetchWorkspaceDetails.mockResolvedValueOnce(stubDetails("Personal"));
    mockParseResult.mockResolvedValueOnce({ ok: false, error: "boom" });

    const result = await getBlock2Inputs("ws-1", logger);
    expect(result.details.name).toBe("Personal");
    expect(result.config).toBeUndefined();
  });

  it("isolates entries per workspaceId", async () => {
    mockFetchWorkspaceDetails
      .mockResolvedValueOnce(stubDetails("First"))
      .mockResolvedValueOnce(stubDetails("Second"));
    mockParseResult
      .mockResolvedValueOnce({ ok: true, data: { config: { id: "a" } } })
      .mockResolvedValueOnce({ ok: true, data: { config: { id: "b" } } });

    const a = await getBlock2Inputs("ws-a", logger);
    const b = await getBlock2Inputs("ws-b", logger);
    expect(a.config).toEqual({ id: "a" });
    expect(b.config).toEqual({ id: "b" });
  });

  it("evicts least-recently-used entries past the cap", async () => {
    // Cap is 64; queue 65 unique workspaces. The oldest should be
    // evicted, forcing a re-fetch when re-asked.
    const CAP = 64;
    const N = CAP + 1;
    for (let i = 0; i < N; i++) {
      mockFetchWorkspaceDetails.mockResolvedValueOnce(stubDetails(`ws-${i}`));
      mockParseResult.mockResolvedValueOnce({ ok: true, data: { config: { i } } });
    }
    for (let i = 0; i < N; i++) {
      await getBlock2Inputs(`ws-${i}`, logger);
    }
    // 65 fills triggered 65 fetches.
    expect(mockFetchWorkspaceDetails).toHaveBeenCalledTimes(N);

    // ws-0 should have been evicted (oldest at the time the 65th was inserted).
    // Re-asking it triggers a fresh fetch (#66).
    mockFetchWorkspaceDetails.mockResolvedValueOnce(stubDetails("ws-0-refetched"));
    mockParseResult.mockResolvedValueOnce({ ok: true, data: { config: { refetched: true } } });
    const refetched = await getBlock2Inputs("ws-0", logger);
    expect(refetched.details.name).toBe("ws-0-refetched");
    expect(mockFetchWorkspaceDetails).toHaveBeenCalledTimes(N + 1);

    // ws-1 should still be cached (it was the oldest after ws-0's eviction,
    // but no further inserts happened past it before refetching ws-0…
    // actually inserting ws-0-refetched evicted ws-1). So ws-1 is also a miss.
    mockFetchWorkspaceDetails.mockResolvedValueOnce(stubDetails("ws-1-refetched"));
    mockParseResult.mockResolvedValueOnce({ ok: true, data: { config: {} } });
    await getBlock2Inputs("ws-1", logger);
    expect(mockFetchWorkspaceDetails).toHaveBeenCalledTimes(N + 2);

    // But ws-N-1 (the most recent in the original fill) is still cached:
    // a re-read should hit without a fetch.
    const lastIdx = N - 1;
    const fetchesBefore = mockFetchWorkspaceDetails.mock.calls.length;
    await getBlock2Inputs(`ws-${lastIdx}`, logger);
    expect(mockFetchWorkspaceDetails).toHaveBeenCalledTimes(fetchesBefore);
  });
});
