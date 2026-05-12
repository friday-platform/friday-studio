import { DAEMON_BASE_URL } from "$lib/daemon-url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./+server.ts";

function failAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

describe("daemon proxy route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aborts the upstream daemon fetch when a downstream SSE client disconnects", async () => {
    let upstreamSignal: AbortSignal | undefined;
    let upstreamCancel!: () => void;
    const upstreamCancelled = new Promise<void>((resolve) => {
      upstreamCancel = resolve;
    });

    const upstreamBody = new ReadableStream<Uint8Array>({
      cancel() {
        upstreamCancel();
      },
    });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Response(upstreamBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET({
      params: { path: "api/me/stream" },
      request: new Request("http://localhost/api/daemon/api/me/stream"),
    } as unknown as Parameters<typeof GET>[0]);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(upstreamSignal?.aborted).toBe(false);

    await response.body?.getReader().cancel();

    expect(upstreamSignal?.aborted).toBe(true);
    await Promise.race([
      upstreamCancelled,
      failAfter(500, "timed out waiting for upstream SSE body cancellation"),
    ]);
  });

  it("forwards percent-encoded path segments without decoding", async () => {
    // GitHub chat IDs contain literal `/` (e.g.
    // `github:owner/repo:issue:2`). The client sends them URL-encoded; if
    // the proxy decodes `%2F` -> `/` the daemon's `:chatId` route only
    // matches up to the first slash and 404s. This pins the round-trip.
    const encodedChatId = "github%3Aowner%2Frepo%3Aissue%3A2";
    const incomingPath = `/api/daemon/api/workspaces/ws-1/chat/${encodedChatId}`;

    let upstreamUrl: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      upstreamUrl = typeof input === "string" ? input : input.toString();
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET({
      // params.path is what SvelteKit would hand us — already decoded.
      // The fix must not use this value to reconstruct the URL.
      params: { path: "api/workspaces/ws-1/chat/github:owner/repo:issue:2" },
      request: new Request(`http://localhost${incomingPath}`),
    } as unknown as Parameters<typeof GET>[0]);

    expect(response.status).toBe(200);
    expect(upstreamUrl).toBeDefined();
    const forwarded = new URL(upstreamUrl!);
    expect(forwarded.origin).toBe(new URL(DAEMON_BASE_URL).origin);
    expect(forwarded.pathname).toBe(`/api/workspaces/ws-1/chat/${encodedChatId}`);
  });
});
