import { env } from "node:process";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportRoute } from "./export.ts";

const DAEMON_URL = "https://daemon.example:9443";
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 250 * 1024 * 1024;

const originalEnv = {
  FRIDAYD_URL: env.FRIDAYD_URL,
  FRIDAY_TLS_CERT: env.FRIDAY_TLS_CERT,
  FRIDAY_TLS_KEY: env.FRIDAY_TLS_KEY,
};

interface RouteCall {
  url: string;
  init?: RequestInit;
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bytesResponse(body: BodyInit, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/octet-stream" } });
}

function sampleChat() {
  return {
    chat: {
      id: "chat-1",
      userId: "user-1",
      workspaceId: "ws-1",
      source: "playground",
      title: "Export Test",
      createdAt: "2026-05-04T12:00:00.000Z",
      updatedAt: "2026-05-04T12:05:00.000Z",
    },
    messages: [
      {
        id: "m1",
        role: "assistant",
        parts: [
          { type: "tool-run_code", output: { scratch_dir: "/Users/alice/.atlas/scratch/abc123" } },
        ],
      },
    ],
    systemPromptContext: null,
  };
}

interface SampleArtifact {
  id: string;
  type: "file";
  revision: number;
  title: string;
  summary: string;
  createdAt: string;
  workspaceId: string;
  chatId: string;
  mimeType: string;
  size: number;
  originalName: string;
}

function sampleArtifact(id: string, overrides: Partial<SampleArtifact> = {}): SampleArtifact {
  return {
    id,
    type: "file" as const,
    revision: 1,
    title: `Artifact ${id}`,
    summary: "Test artifact",
    createdAt: "2026-05-04T12:00:00.000Z",
    workspaceId: "ws-1",
    chatId: "chat-1",
    mimeType: "text/plain",
    size: 4,
    originalName: `${id}.txt`,
    ...overrides,
  };
}

async function decodeZip(res: Response): Promise<JSZip> {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  return await JSZip.loadAsync(await res.arrayBuffer());
}

function stubDaemonFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: RouteCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return await handler(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

async function callExport(signal?: AbortSignal): Promise<Response> {
  const request = new Request("http://playground.local/ws-1/chat-1", { signal });
  return await exportRoute.fetch(request);
}

describe("chat export Hono route", () => {
  beforeEach(() => {
    env.FRIDAYD_URL = DAEMON_URL;
    delete env.FRIDAY_TLS_CERT;
    delete env.FRIDAY_TLS_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreEnv();
  });

  it("uses the runtime daemon URL and packs scrubbed chat JSON plus artifact bytes", async () => {
    const artifact = sampleArtifact("art-1", { originalName: "notes.txt" });
    const { calls } = stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return jsonResponse(sampleChat());
      }
      if (url === `${DAEMON_URL}/api/artifacts?chatId=chat-1`) {
        return jsonResponse({ artifacts: [artifact] });
      }
      if (url === `${DAEMON_URL}/api/artifacts/art-1/content`) {
        return bytesResponse("note bytes");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();

    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="friday-chat-chat-1.zip"',
    );
    const zip = await decodeZip(res);
    const chatJson = (await zip.file("chat.json")?.async("string")) ?? "";
    const parsed = JSON.parse(chatJson) as { chat: { userId?: string }; messages: unknown[] };
    expect(parsed.chat.userId).toBeUndefined();
    expect(chatJson).not.toContain("/Users/alice");
    expect(chatJson).toContain("/Users/~/.atlas/scratch/abc123");
    expect(await zip.file("assets/artifacts/art-1/notes.txt")?.async("string")).toBe("note bytes");
    expect(calls[0]?.url).toBe(`${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`);
  });

  it("returns a 404 JSON response when the daemon reports a missing chat", async () => {
    stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return jsonResponse({ error: "Chat not found" }, 404);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Chat not found" });
  });

  it("returns 502 when the required chat fetch fails", async () => {
    stubDaemonFetch(() => {
      throw new Error("daemon down");
    });

    const res = await callExport();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "daemon fetch failed: daemon down" });
  });

  it("exports chat.json when the non-critical artifact list fetch fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return jsonResponse(sampleChat());
      }
      if (url === `${DAEMON_URL}/api/artifacts?chatId=chat-1`) {
        throw new Error("artifact endpoint down");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();

    const zip = await decodeZip(res);
    expect(zip.file("chat.json")).not.toBeNull();
    expect(Object.keys(zip.files)).toEqual(["chat.json"]);
  });

  it("exports chat.json when the artifact list returns malformed JSON", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return jsonResponse(sampleChat());
      }
      if (url === `${DAEMON_URL}/api/artifacts?chatId=chat-1`) {
        return new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();

    const zip = await decodeZip(res);
    expect(zip.file("chat.json")).not.toBeNull();
    expect(Object.keys(zip.files)).toEqual(["chat.json"]);
  });

  it("skips artifacts whose declared size exceeds the per-artifact ceiling before fetching bytes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const huge = sampleArtifact("huge", { size: MAX_ARTIFACT_BYTES + 1 });
    const { calls } = stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return jsonResponse(sampleChat());
      }
      if (url === `${DAEMON_URL}/api/artifacts?chatId=chat-1`) {
        return jsonResponse({ artifacts: [huge] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();

    const zip = await decodeZip(res);
    expect(zip.file("chat.json")).not.toBeNull();
    expect(calls.some((call) => call.url.includes("/content"))).toBe(false);
  });

  it("returns 413 before byte fetches when declared artifact sizes exceed the aggregate ceiling", async () => {
    const artifacts = Array.from({ length: 11 }, (_, idx) =>
      sampleArtifact(`art-${idx}`, { size: MAX_TOTAL_ARTIFACT_BYTES / 10 }),
    );
    const { calls } = stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return jsonResponse(sampleChat());
      }
      if (url === `${DAEMON_URL}/api/artifacts?chatId=chat-1`) {
        return jsonResponse({ artifacts });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: "Export exceeds size limit",
      limit: MAX_TOTAL_ARTIFACT_BYTES,
    });
    expect(calls.some((call) => call.url.includes("/content"))).toBe(false);
  });

  it("skips unsafe dot-segment artifact ids before constructing content fetch URLs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dotty = sampleArtifact("..");
    const { calls } = stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return jsonResponse(sampleChat());
      }
      if (url === `${DAEMON_URL}/api/artifacts?chatId=chat-1`) {
        return jsonResponse({ artifacts: [dotty] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();

    const zip = await decodeZip(res);
    expect(zip.file("chat.json")).not.toBeNull();
    expect(calls.some((call) => call.url.includes("/content"))).toBe(false);
  });

  it("returns 499 when the request is already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();
    stubDaemonFetch((_url, init) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      throw new Error("expected aborted signal");
    });

    const res = await callExport(abortController.signal);

    expect(res.status).toBe(499);
  });

  it("drops an artifact whose body exceeds the byte ceiling despite a small declared size", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const artifact = sampleArtifact("stale-size", { size: 1 });
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 26; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return jsonResponse(sampleChat());
      }
      if (url === `${DAEMON_URL}/api/artifacts?chatId=chat-1`) {
        return jsonResponse({ artifacts: [artifact] });
      }
      if (url === `${DAEMON_URL}/api/artifacts/stale-size/content`) {
        return bytesResponse(body);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();

    const zip = await decodeZip(res);
    expect(zip.file("assets/artifacts/stale-size/stale-size.txt")).toBeNull();
  });
});
