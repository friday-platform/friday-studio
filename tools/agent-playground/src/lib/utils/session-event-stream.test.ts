import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionEventStream } from "./session-event-stream.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe("sessionEventStream abort handling", () => {
  it("does not open an SSE request when the caller signal is already aborted", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;

    const controller = new AbortController();
    controller.abort();

    await expect(sessionEventStream("session-1", { signal: controller.signal }).next())
      .resolves.toEqual({ value: undefined, done: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates caller aborts to the in-flight SSE fetch", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      requestSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    globalThis.fetch = fetchMock;

    const controller = new AbortController();
    const next = sessionEventStream("session-1", { signal: controller.signal }).next();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requestSignal?.aborted).toBe(false);

    controller.abort();

    await expect(next).resolves.toEqual({ value: undefined, done: true });
    expect(requestSignal?.aborted).toBe(true);
  });
});
