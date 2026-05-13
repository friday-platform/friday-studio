import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProxyHandler, HOP_BY_HOP_HEADERS } from "./proxy.ts";

/** Build a SvelteKit `RequestEvent`-shaped argument for the handler.
 * The catch-all `[...path]/+server.ts` route would populate
 * `params.path` from the URL; we set it directly. */
function event(opts: {
  path: string;
  method?: string;
  url?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal;
}): Parameters<ReturnType<typeof buildProxyHandler>>[0] {
  const request = new Request(opts.url ?? `https://playground.local/api/x/${opts.path}`, {
    method: opts.method ?? "GET",
    headers: opts.headers,
    body: opts.body ?? null,
    signal: opts.signal,
  });
  // RequestEvent has many fields we don't exercise; cast through unknown.
  return { params: { path: opts.path }, request } as unknown as Parameters<
    ReturnType<typeof buildProxyHandler>
  >[0];
}

describe("buildProxyHandler", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("forwards path + query to the upstream URL", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const handler = buildProxyHandler({ upstream: "https://daemon.local:8080", label: "daemon" });
    await handler(
      event({ path: "api/workspaces/x", url: "https://playground.local/api/daemon/api/workspaces/x?foo=1" }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const target = fetchMock.mock.calls[0]?.[0] as URL;
    expect(target.toString()).toBe("https://daemon.local:8080/api/workspaces/x?foo=1");
  });

  it("strips hop-by-hop headers from the response", async () => {
    const upstreamHeaders = new Headers({
      "content-type": "application/json",
      "transfer-encoding": "chunked",
      connection: "keep-alive",
      "x-custom": "preserve-me",
    });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200, headers: upstreamHeaders }));
    const handler = buildProxyHandler({ upstream: "https://daemon.local:8080", label: "daemon" });
    const res = await handler(event({ path: "anything" }));
    for (const h of HOP_BY_HOP_HEADERS) {
      expect(res.headers.get(h)).toBeNull();
    }
    expect(res.headers.get("x-custom")).toBe("preserve-me");
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("buffers request body for POST so upstream short-circuits don't race", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    const handler = buildProxyHandler({ upstream: "https://daemon.local:8080", label: "daemon" });
    const res = await handler(
      event({ path: "p", method: "POST", body: JSON.stringify({ a: 1 }) }),
    );
    expect(res.status).toBe(401);
    const callBody = fetchMock.mock.calls[0]?.[1]?.body;
    // Buffered as Uint8Array — never a ReadableStream that could race.
    expect(callBody).toBeInstanceOf(Uint8Array);
  });

  it("returns 502 with label-tagged JSON when upstream fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("connection refused"));
    const handler = buildProxyHandler({ upstream: "https://tunnel.local:9090", label: "tunnel" });
    const res = await handler(event({ path: "status" }));
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/^tunnel proxy fetch failed:/);
    expect(json.error).toContain("connection refused");
  });

  it("passes SSE responses through with the same status + cleaned headers", async () => {
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream", connection: "keep-alive" },
      }),
    );
    const handler = buildProxyHandler({ upstream: "https://daemon.local:8080", label: "daemon" });
    const res = await handler(event({ path: "stream" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("connection")).toBeNull();
    expect(await res.text()).toBe("data: hello\n\n");
  });

  it("aborts the upstream fetch when the client aborts", async () => {
    let abortedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      abortedSignal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const ctrl = new AbortController();
    const handler = buildProxyHandler({ upstream: "https://daemon.local:8080", label: "daemon" });
    const responsePromise = handler(event({ path: "slow", signal: ctrl.signal }));
    // Tick once so fetch is in-flight before we abort.
    await Promise.resolve();
    ctrl.abort();
    const res = await responsePromise;
    expect(res.status).toBe(502);
    expect(abortedSignal?.aborted).toBe(true);
  });
});
