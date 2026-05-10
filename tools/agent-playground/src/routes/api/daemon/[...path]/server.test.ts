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
      params: { path: "api/elicitations/stream" },
      request: new Request(
        "http://localhost/api/daemon/api/elicitations/stream?workspaceId=leak_probe",
      ),
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
});
