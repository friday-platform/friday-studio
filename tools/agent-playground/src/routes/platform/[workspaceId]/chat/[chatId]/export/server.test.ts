/**
 * Integration tests for the chat-export orchestrator route.
 *
 * The orchestrator stitches together three upstream fetches (preview HTML,
 * chat JSON, artifact list + per-artifact bytes) and a zip pack. We exercise
 * it via a stubbed `event.fetch` that routes URLs to canned responses, then
 * decode the resulting zip with `jszip` and assert on its entries — same
 * decode pattern the now-deleted daemon route's test (`apps/atlasd/routes/
 * workspaces/chat.test.ts`) used.
 */

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the byte ceilings down to test-friendly values so the per-artifact
// and aggregate ceiling branches are exercisable without allocating tens
// or hundreds of megabytes per test. The real production values live in
// `./limits.ts` (25 MB / 250 MB) — see that module for rationale.
const TEST_MAX_ARTIFACT_BYTES = 1024;
const TEST_MAX_TOTAL_ARTIFACT_BYTES = 4096;
vi.mock("./limits", () => ({
  MAX_ARTIFACT_BYTES: TEST_MAX_ARTIFACT_BYTES,
  MAX_TOTAL_ARTIFACT_BYTES: TEST_MAX_TOTAL_ARTIFACT_BYTES,
}));

const { GET } = await import("./+server");

interface FakeEvent {
  params: { workspaceId?: string; chatId?: string };
  fetch: typeof globalThis.fetch;
  // The route reads `event.request.signal` so a closed-tab abort can cascade
  // through the upstream fetches. Tests provide a never-aborting controller
  // by default; the timeout test substitutes its own.
  request: { signal: AbortSignal };
}

function makeRequest(): { signal: AbortSignal } {
  // A fresh, never-aborted AbortController stands in for SvelteKit's real
  // `event.request`. Using `AbortSignal.any([...])` in production code
  // requires a real `AbortSignal`, so a plain object isn't enough.
  return { signal: new AbortController().signal };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function bytesResponse(text: string, status = 200): Response {
  // The orchestrator reads the body via `arrayBuffer()`, so passing a
  // string is fine — the Response constructor encodes UTF-8 and the
  // round-trip through `arrayBuffer()` reads the same bytes back.
  return new Response(text, { status, headers: { "content-type": "application/octet-stream" } });
}

interface RouteHandler {
  match: (url: string) => boolean;
  respond: () => Response | Promise<Response>;
}

/**
 * Build a `fetch` stub from URL→handler pairs. Patterns are matched in
 * order against the request URL via `startsWith`; first match wins. This
 * is the same shape the preview test uses (`preview.test.ts`).
 */
function makeFetch(routes: RouteHandler[]): typeof globalThis.fetch {
  return (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const route of routes) {
      if (route.match(url)) return route.respond();
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof globalThis.fetch;
}

const SAMPLE_CHAT_ID = "chat-export-1234567890abcdef";
const SAMPLE_WS_ID = "ws-1";

const sampleChatPayload = {
  chat: {
    id: SAMPLE_CHAT_ID,
    userId: "user-1",
    workspaceId: SAMPLE_WS_ID,
    source: "playground",
    title: "Export Test Chat",
    createdAt: "2026-05-04T12:00:00.000Z",
    updatedAt: "2026-05-04T12:05:00.000Z",
  },
  messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] }],
  systemPromptContext: null,
};

function sampleArtifact(id: string, originalName: string) {
  return {
    id,
    type: "file",
    revision: 1,
    title: `Artifact ${id}`,
    summary: "Test",
    createdAt: "2026-05-04T12:00:00.000Z",
    workspaceId: SAMPLE_WS_ID,
    chatId: SAMPLE_CHAT_ID,
    mimeType: "text/plain",
    size: 4,
    originalName,
  };
}

function callGet(event: FakeEvent): Promise<Response> {
  // SvelteKit's `RequestHandler` is invoked with a far richer event in
  // production; the test event omits unused fields. The fixture cast is
  // the documented exception to the no-`as` rule.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return GET(event as any) as Promise<Response>;
}

async function decodeZip(res: Response): Promise<JSZip> {
  const buf = new Uint8Array(await res.arrayBuffer());
  // Magic bytes: PK\x03\x04 — every non-empty zip starts with the local
  // file header signature.
  expect(buf[0]).toBe(0x50);
  expect(buf[1]).toBe(0x4b);
  expect(buf[2]).toBe(0x03);
  expect(buf[3]).toBe(0x04);
  return await JSZip.loadAsync(buf);
}

describe("GET /platform/:wsId/chat/:chatId/export — zip orchestrator", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("packs preview HTML, chat JSON, and one artifact entry per successful byte fetch", async () => {
    const a1 = sampleArtifact("art-aaaa", "a.txt");
    const a2 = sampleArtifact("art-bbbb", "b.txt");
    const event: FakeEvent = {
      params: { workspaceId: SAMPLE_WS_ID, chatId: SAMPLE_CHAT_ID },
      request: makeRequest(),
      fetch: makeFetch([
        {
          match: (u) => u.includes("/export/preview"),
          respond: () => htmlResponse("<html><body>preview body</body></html>"),
        },
        {
          match: (u) => u.includes("/api/daemon/api/workspaces/") && u.includes("?full=true"),
          respond: () => jsonResponse(sampleChatPayload),
        },
        {
          match: (u) => u.includes("/api/daemon/api/artifacts?chatId="),
          respond: () => jsonResponse({ artifacts: [a1, a2] }),
        },
        { match: (u) => u.endsWith("/art-aaaa/content"), respond: () => bytesResponse("AAAA") },
        { match: (u) => u.endsWith("/art-bbbb/content"), respond: () => bytesResponse("BBBB") },
      ]),
    };

    const res = await callGet(event);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="friday-chat-${SAMPLE_CHAT_ID.slice(0, 8)}.zip"`,
    );

    const zip = await decodeZip(res);
    expect(zip.file("index.html")).not.toBeNull();
    expect(zip.file("chat.json")).not.toBeNull();
    expect(zip.file("assets/artifacts/art-aaaa/a.txt")).not.toBeNull();
    expect(zip.file("assets/artifacts/art-bbbb/b.txt")).not.toBeNull();

    const html = await zip.file("index.html")?.async("string");
    expect(html).toContain("preview body");
    // The preview is rendered with `csr=false` and `inlineStyleThreshold:
    // Infinity` so the exported HTML is portable — no external CSS link
    // tags, no client-side script tags. Lock that in: a regression that
    // re-introduces either would silently break recipients who open the
    // file offline.
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toMatch(/<script[\s>]/i);

    const chatJson = await zip.file("chat.json")?.async("string");
    const parsed = JSON.parse(chatJson ?? "{}") as Record<string, unknown>;
    expect(parsed).toHaveProperty("chat");
    expect(parsed).toHaveProperty("messages");
    expect(parsed).toHaveProperty("systemPromptContext");
    expect((parsed.chat as { id: string; userId?: string }).id).toBe(SAMPLE_CHAT_ID);
    // `userId` is intentionally stripped at the zip boundary — see +server.ts.
    expect((parsed.chat as { id: string; userId?: string }).userId).toBeUndefined();
    expect(Object.keys(parsed.chat as object)).not.toContain("userId");

    const a1Bytes = await zip.file("assets/artifacts/art-aaaa/a.txt")?.async("string");
    expect(a1Bytes).toBe("AAAA");
  });

  it("does not fail the export when a single artifact byte fetch fails — entry omitted, others kept", async () => {
    const ok = sampleArtifact("art-ok", "ok.txt");
    const bad = sampleArtifact("art-bad", "bad.txt");
    const event: FakeEvent = {
      params: { workspaceId: SAMPLE_WS_ID, chatId: SAMPLE_CHAT_ID },
      request: makeRequest(),
      fetch: makeFetch([
        {
          match: (u) => u.includes("/export/preview"),
          respond: () => htmlResponse("<html>ok</html>"),
        },
        {
          match: (u) => u.includes("/api/daemon/api/workspaces/") && u.includes("?full=true"),
          respond: () => jsonResponse(sampleChatPayload),
        },
        {
          match: (u) => u.includes("/api/daemon/api/artifacts?chatId="),
          respond: () => jsonResponse({ artifacts: [ok, bad] }),
        },
        { match: (u) => u.endsWith("/art-ok/content"), respond: () => bytesResponse("good") },
        {
          match: (u) => u.endsWith("/art-bad/content"),
          respond: () => new Response("boom", { status: 500 }),
        },
      ]),
    };

    const res = await callGet(event);

    expect(res.status).toBe(200);
    const zip = await decodeZip(res);
    expect(zip.file("assets/artifacts/art-ok/ok.txt")).not.toBeNull();
    // Failed read is omitted; the HTML's broken link is the recipient
    // signal, not a failure of the export as a whole.
    expect(zip.file("assets/artifacts/art-bad/bad.txt")).toBeNull();
  });

  it("returns 504 with the timeout error body when the preview fetch is aborted by the 10s ceiling", async () => {
    vi.useFakeTimers();
    try {
      const event: FakeEvent = {
        params: { workspaceId: SAMPLE_WS_ID, chatId: SAMPLE_CHAT_ID },
        request: makeRequest(),
        // Preview handler hangs until the orchestrator's AbortController
        // fires. The route attaches `previewController.signal` to the
        // event.fetch call, so the abort surfaces as a rejection that
        // the catch block translates to 504.
        fetch: ((async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          if (url.includes("/export/preview")) {
            return await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("aborted", "AbortError"));
              });
            });
          }
          throw new Error(`Unexpected fetch in test: ${url}`);
        }) as typeof globalThis.fetch),
      };

      const resPromise = callGet(event);
      // Step past the 10s ceiling — the route's setTimeout fires and
      // aborts the preview fetch above.
      await vi.advanceTimersByTimeAsync(10_001);
      const res = await resPromise;

      expect(res.status).toBe(504);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Chat too large to export");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 502 in the outer catch when the preview fetch throws a non-AbortError", async () => {
    const event: FakeEvent = {
      params: { workspaceId: SAMPLE_WS_ID, chatId: SAMPLE_CHAT_ID },
      request: makeRequest(),
      fetch: makeFetch([
        {
          match: (u) => u.includes("/export/preview"),
          respond: () => {
            // Daemon-down style failure — not an abort, so the route
            // takes the 502 branch in the catch.
            throw new Error("daemon dead");
          },
        },
      ]),
    };

    const res = await callGet(event);

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("daemon dead");
  });

  it("omits an artifact whose body exceeds MAX_ARTIFACT_BYTES; the rest of the export still succeeds", async () => {
    const small = sampleArtifact("art-small", "small.txt");
    const huge = sampleArtifact("art-huge", "huge.txt");
    // One byte over the (mocked, test-only) per-artifact ceiling.
    const oversize = new Uint8Array(TEST_MAX_ARTIFACT_BYTES + 1);
    const event: FakeEvent = {
      params: { workspaceId: SAMPLE_WS_ID, chatId: SAMPLE_CHAT_ID },
      request: makeRequest(),
      fetch: makeFetch([
        {
          match: (u) => u.includes("/export/preview"),
          respond: () => htmlResponse("<html>ok</html>"),
        },
        {
          match: (u) => u.includes("/api/daemon/api/workspaces/") && u.includes("?full=true"),
          respond: () => jsonResponse(sampleChatPayload),
        },
        {
          match: (u) => u.includes("/api/daemon/api/artifacts?chatId="),
          respond: () => jsonResponse({ artifacts: [small, huge] }),
        },
        { match: (u) => u.endsWith("/art-small/content"), respond: () => bytesResponse("ok") },
        {
          match: (u) => u.endsWith("/art-huge/content"),
          respond: () =>
            new Response(oversize, {
              status: 200,
              headers: { "content-type": "application/octet-stream" },
            }),
        },
      ]),
    };

    const res = await callGet(event);

    expect(res.status).toBe(200);
    const zip = await decodeZip(res);
    // Small artifact survives; oversize one is dropped (same skip-and-warn
    // path as a fetch failure — recipient sees one missing download).
    expect(zip.file("assets/artifacts/art-small/small.txt")).not.toBeNull();
    expect(zip.file("assets/artifacts/art-huge/huge.txt")).toBeNull();
  });

  it("returns 413 when the surviving artifacts' total bytes exceed MAX_TOTAL_ARTIFACT_BYTES", async () => {
    // Three artifacts, each within the per-artifact ceiling but together
    // over the aggregate ceiling. With TEST_MAX_ARTIFACT_BYTES = 1024 and
    // TEST_MAX_TOTAL_ARTIFACT_BYTES = 4096, three 1024-byte artifacts =
    // 3072 (under), four = 4096 (under), five = 5120 (over).
    const a1 = sampleArtifact("art-1", "1.bin");
    const a2 = sampleArtifact("art-2", "2.bin");
    const a3 = sampleArtifact("art-3", "3.bin");
    const a4 = sampleArtifact("art-4", "4.bin");
    const a5 = sampleArtifact("art-5", "5.bin");
    const chunk = new Uint8Array(TEST_MAX_ARTIFACT_BYTES);
    const chunkResponse = (): Response =>
      new Response(chunk, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    const event: FakeEvent = {
      params: { workspaceId: SAMPLE_WS_ID, chatId: SAMPLE_CHAT_ID },
      request: makeRequest(),
      fetch: makeFetch([
        {
          match: (u) => u.includes("/export/preview"),
          respond: () => htmlResponse("<html>ok</html>"),
        },
        {
          match: (u) => u.includes("/api/daemon/api/workspaces/") && u.includes("?full=true"),
          respond: () => jsonResponse(sampleChatPayload),
        },
        {
          match: (u) => u.includes("/api/daemon/api/artifacts?chatId="),
          respond: () => jsonResponse({ artifacts: [a1, a2, a3, a4, a5] }),
        },
        { match: (u) => u.endsWith("/art-1/content"), respond: chunkResponse },
        { match: (u) => u.endsWith("/art-2/content"), respond: chunkResponse },
        { match: (u) => u.endsWith("/art-3/content"), respond: chunkResponse },
        { match: (u) => u.endsWith("/art-4/content"), respond: chunkResponse },
        { match: (u) => u.endsWith("/art-5/content"), respond: chunkResponse },
      ]),
    };

    const res = await callGet(event);

    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { error: string; totalBytes: number; limit: number };
    expect(body.error).toBe("Export exceeds size limit");
    expect(body.limit).toBe(TEST_MAX_TOTAL_ARTIFACT_BYTES);
    expect(body.totalBytes).toBeGreaterThan(TEST_MAX_TOTAL_ARTIFACT_BYTES);
  });

  it("bails with 499 when the signal aborts after preview (post-preview check)", async () => {
    // Exercises the *first* `requestSignal.aborted` check (right after the
    // preview fetch resolves). Aborting inside the preview handler makes
    // the signal aborted before control reaches that check; the orchestrator
    // short-circuits and never fans out to chat/artifacts/bytes.
    const abortController = new AbortController();
    const event: FakeEvent = {
      params: { workspaceId: SAMPLE_WS_ID, chatId: SAMPLE_CHAT_ID },
      request: { signal: abortController.signal },
      fetch: ((async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.includes("/export/preview")) {
          abortController.abort();
          return htmlResponse("<html>ok</html>");
        }
        // If we reach this branch the post-preview check failed to fire.
        throw new Error(`Unexpected fetch after abort: ${url}`);
      }) as typeof globalThis.fetch),
    };
    const generateSpy = vi
      .spyOn(JSZip.prototype, "generateAsync")
      .mockResolvedValue(new ArrayBuffer(0));

    const res = await callGet(event);

    expect(res.status).toBe(499);
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("bails with 499 when the signal aborts after Promise.allSettled (post-fanout check)", async () => {
    // Exercises the *second* `requestSignal.aborted` check (right after
    // the per-artifact `Promise.allSettled` resolves). Preview + chat +
    // artifact list all complete normally; the abort fires once the
    // per-artifact fetch starts, so allSettled finishes with rejected
    // entries and the post-fanout check trips.
    const abortController = new AbortController();
    const a1 = sampleArtifact("art-aaaa", "a.txt");
    const event: FakeEvent = {
      params: { workspaceId: SAMPLE_WS_ID, chatId: SAMPLE_CHAT_ID },
      request: { signal: abortController.signal },
      fetch: ((async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.includes("/export/preview")) {
          return htmlResponse("<html>ok</html>");
        }
        if (url.includes("/api/daemon/api/workspaces/") && url.includes("?full=true")) {
          return jsonResponse(sampleChatPayload);
        }
        if (url.includes("/api/daemon/api/artifacts?chatId=")) {
          return jsonResponse({ artifacts: [a1] });
        }
        // Per-artifact byte fetch — abort the request signal here, then
        // reject so allSettled records a rejection and the post-fanout
        // abort check fires when control returns to the orchestrator.
        if (url.endsWith("/art-aaaa/content")) {
          abortController.abort();
          if (init?.signal?.aborted) {
            throw new DOMException("aborted", "AbortError");
          }
          throw new Error("artifact byte fetch was not given the request signal");
        }
        throw new Error(`Unexpected fetch in test: ${url}`);
      }) as typeof globalThis.fetch),
    };
    const generateSpy = vi
      .spyOn(JSZip.prototype, "generateAsync")
      .mockResolvedValue(new ArrayBuffer(0));

    const res = await callGet(event);

    expect(res.status).toBe(499);
    // The post-fanout check guards `zip.generateAsync` from ever running
    // — even though the preview / chat / artifact-list fetches completed,
    // we don't pay for packing a zip the client closed.
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("slugs a hostile artifact id end-to-end so the produced zip cannot escape `assets/artifacts/`", async () => {
    // Pairs with the `artifactZipPath` unit test in `preview.test.ts`. The
    // unit test proves the helper, this one proves the orchestrator's
    // wire-up: a hostile id at the daemon API boundary lands on a slugged
    // path inside the zip, with no `..` segment anywhere in the entry list.
    const hostile = sampleArtifact("../../etc/passwd", "x.txt");
    const event: FakeEvent = {
      params: { workspaceId: SAMPLE_WS_ID, chatId: SAMPLE_CHAT_ID },
      request: makeRequest(),
      fetch: makeFetch([
        {
          match: (u) => u.includes("/export/preview"),
          respond: () => htmlResponse("<html>ok</html>"),
        },
        {
          match: (u) => u.includes("/api/daemon/api/workspaces/") && u.includes("?full=true"),
          respond: () => jsonResponse(sampleChatPayload),
        },
        {
          match: (u) => u.includes("/api/daemon/api/artifacts?chatId="),
          respond: () => jsonResponse({ artifacts: [hostile] }),
        },
        {
          // The orchestrator URL-encodes the id when building the byte
          // fetch URL, so the upstream stub matches on the encoded form.
          match: (u) => u.includes(`/${encodeURIComponent("../../etc/passwd")}/content`),
          respond: () => bytesResponse("safe"),
        },
      ]),
    };

    const res = await callGet(event);
    expect(res.status).toBe(200);
    const zip = await decodeZip(res);
    const entries = Object.keys(zip.files);
    // No entry escapes the assets dir — the slug rewrites every `/` and
    // the pure-dot reject collapses `..` segments to `artifact`.
    for (const entry of entries) {
      expect(entry).not.toMatch(/(^|\/)\.\.(\/|$)/);
    }
    // The hostile id maps to the slugged dir name; the basename `x.txt`
    // survives unchanged because it's already ASCII-safe.
    expect(zip.file("assets/artifacts/.._.._etc_passwd/x.txt")).not.toBeNull();
  });

  it("slugs a pure-dot artifact id end-to-end so it lands at `assets/artifacts/artifact/...`", async () => {
    // Pairs with the `slug e2e` test above (`../../etc/passwd` form). This
    // covers the bare `..` case — the exact threat that slipped past round
    // 2 because the round-2 fix only rewrote `/` and the round-3 fix added
    // the pure-dot reject. A regression in the reject would land here.
    //
    // `encodeURIComponent("..") === ".."` (dots are unreserved), so the
    // byte-fetch URL is literally `…/api/artifacts/../content`.
    const dotty = sampleArtifact("..", "x.txt");
    const event: FakeEvent = {
      params: { workspaceId: SAMPLE_WS_ID, chatId: SAMPLE_CHAT_ID },
      request: makeRequest(),
      fetch: makeFetch([
        {
          match: (u) => u.includes("/export/preview"),
          respond: () => htmlResponse("<html>ok</html>"),
        },
        {
          match: (u) => u.includes("/api/daemon/api/workspaces/") && u.includes("?full=true"),
          respond: () => jsonResponse(sampleChatPayload),
        },
        {
          match: (u) => u.includes("/api/daemon/api/artifacts?chatId="),
          respond: () => jsonResponse({ artifacts: [dotty] }),
        },
        {
          match: (u) => u.endsWith("/api/daemon/api/artifacts/../content"),
          respond: () => bytesResponse("safe"),
        },
      ]),
    };

    const res = await callGet(event);
    expect(res.status).toBe(200);
    const zip = await decodeZip(res);
    // Pure-dot id collapses to the `artifact` default; the basename
    // (`x.txt`) is already ASCII-safe and survives unchanged.
    expect(zip.file("assets/artifacts/artifact/x.txt")).not.toBeNull();
    for (const entry of Object.keys(zip.files)) {
      expect(entry).not.toMatch(/(^|\/)\.+(\/|$)/);
    }
  });

  it("scrubs absolute home-directory prefixes in both the HTML and chat.json", async () => {
    // Tools like `run_code` emit `scratch_dir: "/Users/<name>/.atlas/..."`
    // in their output JSON, which lands verbatim in both surfaces. The
    // export must rewrite those prefixes so a shared zip never reveals
    // the sender's username or local layout.
    const previewWithPath =
      '<html><body><span>scratch_dir: /Users/alice/.atlas/scratch/abc123 done</span><span>cwd: /home/bob/work</span></body></html>';
    const chatWithPath = {
      chat: { ...sampleChatPayload.chat },
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [
            {
              type: "tool-run_code",
              toolCallId: "tc",
              state: "output-available",
              output: { scratch_dir: "/Users/alice/.atlas/scratch/abc123" },
            },
          ],
        },
      ],
      systemPromptContext: null,
    };
    const event: FakeEvent = {
      params: { workspaceId: SAMPLE_WS_ID, chatId: SAMPLE_CHAT_ID },
      request: makeRequest(),
      fetch: makeFetch([
        {
          match: (u) => u.includes("/export/preview"),
          respond: () => htmlResponse(previewWithPath),
        },
        {
          match: (u) => u.includes("/api/daemon/api/workspaces/") && u.includes("?full=true"),
          respond: () => jsonResponse(chatWithPath),
        },
        {
          match: (u) => u.includes("/api/daemon/api/artifacts?chatId="),
          respond: () => jsonResponse({ artifacts: [] }),
        },
      ]),
    };

    const res = await callGet(event);
    expect(res.status).toBe(200);

    const zip = await decodeZip(res);
    const html = (await zip.file("index.html")?.async("string")) ?? "";
    const chatJson = (await zip.file("chat.json")?.async("string")) ?? "";

    // No raw username paths should survive in either surface.
    expect(html).not.toMatch(/\/Users\/alice/);
    expect(html).not.toMatch(/\/home\/bob/);
    expect(chatJson).not.toMatch(/\/Users\/alice/);

    // The path tail (the part after the username) is preserved so the
    // recipient can still tell what the tool was doing.
    expect(html).toContain("/Users/~/.atlas/scratch/abc123");
    expect(html).toContain("/home/~/work");
    expect(chatJson).toContain("/Users/~/.atlas/scratch/abc123");
  });

  it("forwards a non-2xx preview status (e.g. 404 for missing chat) verbatim", async () => {
    const event: FakeEvent = {
      params: { workspaceId: SAMPLE_WS_ID, chatId: "missing-chat" },
      request: makeRequest(),
      fetch: makeFetch([
        {
          match: (u) => u.includes("/export/preview"),
          respond: () =>
            new Response(JSON.stringify({ error: "Chat not found" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            }),
        },
      ]),
    };

    const res = await callGet(event);
    expect(res.status).toBe(404);
  });
});
