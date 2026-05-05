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

const { GET } = await import("./+server");

interface FakeEvent {
  params: { workspaceId?: string; chatId?: string };
  fetch: typeof globalThis.fetch;
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

  it("forwards a non-2xx preview status (e.g. 404 for missing chat) verbatim", async () => {
    const event: FakeEvent = {
      params: { workspaceId: SAMPLE_WS_ID, chatId: "missing-chat" },
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
