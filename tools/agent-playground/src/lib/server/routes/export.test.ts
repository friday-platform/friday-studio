import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pin the daemon URL the route sees BEFORE importing the route module.
// `effectiveDaemonUrl` is otherwise short-circuited by Vite's
// `__FRIDAY_DAEMON_BASE_URL__` define when these tests run via
// `npx vitest` inside the package directory (the package vite.config.ts
// injects the const). Mocking the helper makes the tests hermetic to the
// vitest invocation path.
const DAEMON_URL = "https://daemon.example:9443";
vi.mock("../daemon-url.ts", () => ({
  effectiveDaemonUrl: () => DAEMON_URL,
}));

const { exportRoute } = await import("./export.ts");

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 250 * 1024 * 1024;
// Kept in sync with `EXPORT_BUDGET_MS` in `export.ts`. The timeout-branch
// test uses fake timers to advance past this without actually waiting.
const EXPORT_BUDGET_MS = 60_000;

interface RouteCall {
  url: string;
  init?: RequestInit;
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

interface CallExportOpts {
  signal?: AbortSignal;
  headers?: HeadersInit;
}

async function callExport(opts: CallExportOpts = {}): Promise<Response> {
  const request = new Request("http://playground.local/ws-1/chat-1", {
    signal: opts.signal,
    headers: opts.headers,
  });
  return await exportRoute.fetch(request);
}

/**
 * Silence `console.warn` for tests that expect a warning, and return a spy
 * the test can assert against. Every silenced test MUST assert the
 * `/[chat-export]` substring was logged so the operator-facing degraded-mode
 * contract is locked even when the exact message wording shifts.
 */
function silenceChatExportWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

function expectChatExportWarn(spy: ReturnType<typeof silenceChatExportWarn>): void {
  expect(spy).toHaveBeenCalled();
  const matched = spy.mock.calls.some((args) =>
    args.some((arg) => typeof arg === "string" && arg.includes("[chat-export]")),
  );
  expect(matched, "expected at least one console.warn argument to contain '[chat-export]'").toBe(
    true,
  );
}

describe("chat export Hono route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it("forwards the caller's cookie and authorization headers to every daemon fetch", async () => {
    // Without this, the daemon's session middleware reads `userId` from a
    // missing cookie and 401s any non-dev-mode caller. Locks the regression
    // surface where the old SvelteKit /api/daemon proxy used to forward
    // headers transparently and the Hono port skipped them.
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

    const res = await callExport({
      headers: { cookie: "friday_session=abc123", authorization: "Bearer xyz" },
    });
    expect(res.status).toBe(200);

    // Three daemon fetches: chat, artifact list, artifact bytes. Every one
    // must carry both headers — a regression that forwards on the first
    // fetch but drops them on the byte fetch would still 401 the caller.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get("cookie")).toBe("friday_session=abc123");
      expect(headers.get("authorization")).toBe("Bearer xyz");
    }
  });

  it("omits cookie/authorization headers when the caller did not send them", async () => {
    // No spurious empty values that would land on the daemon as
    // `Cookie: ` (which some middleware treats differently from
    // "header absent"). Asserts the negative half of the contract.
    const { calls } = stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return jsonResponse(sampleChat());
      }
      if (url === `${DAEMON_URL}/api/artifacts?chatId=chat-1`) {
        return jsonResponse({ artifacts: [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();
    expect(res.status).toBe(200);
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
    }
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

  it("returns 502 when the daemon chat fetch responds with a non-2xx non-404 status", async () => {
    stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return jsonResponse({ error: "Internal Server Error" }, 500);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "daemon chat fetch failed: 500" });
  });

  it("returns 502 when the daemon chat response is not valid JSON", async () => {
    stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/^daemon chat JSON parse failed:/);
  });

  it("returns 502 when the daemon chat response fails the schema", async () => {
    stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        // Missing required `chat` field — fails GetChatResponseSchema.
        return jsonResponse({ messages: [], systemPromptContext: null });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/^daemon chat schema mismatch:/);
  });

  it("exports chat.json when the non-critical artifact list fetch fails", async () => {
    const warn = silenceChatExportWarn();
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
    expectChatExportWarn(warn);
  });

  it("exports chat.json when the artifact list returns malformed JSON", async () => {
    const warn = silenceChatExportWarn();
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
    expectChatExportWarn(warn);
  });

  it("exports chat.json when the artifact list endpoint responds non-2xx", async () => {
    const warn = silenceChatExportWarn();
    stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return jsonResponse(sampleChat());
      }
      if (url === `${DAEMON_URL}/api/artifacts?chatId=chat-1`) {
        return jsonResponse({ error: "boom" }, 500);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();
    const zip = await decodeZip(res);
    expect(Object.keys(zip.files)).toEqual(["chat.json"]);
    expectChatExportWarn(warn);
  });

  it("exports chat.json when the artifact list response fails the schema", async () => {
    const warn = silenceChatExportWarn();
    stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return jsonResponse(sampleChat());
      }
      if (url === `${DAEMON_URL}/api/artifacts?chatId=chat-1`) {
        // `artifacts` is required to be an array; a string trips Zod.
        return jsonResponse({ artifacts: "nope" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();
    const zip = await decodeZip(res);
    expect(Object.keys(zip.files)).toEqual(["chat.json"]);
    expectChatExportWarn(warn);
  });

  it("skips artifacts whose declared size exceeds the per-artifact ceiling before fetching bytes", async () => {
    const warn = silenceChatExportWarn();
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
    expectChatExportWarn(warn);
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
    const warn = silenceChatExportWarn();
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
    expectChatExportWarn(warn);
  });

  it("drops an artifact whose byte fetch returns a non-2xx status; other artifacts still pack", async () => {
    const warn = silenceChatExportWarn();
    const ok = sampleArtifact("art-ok", { originalName: "ok.txt" });
    const bad = sampleArtifact("art-bad", { originalName: "bad.txt" });
    stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return jsonResponse(sampleChat());
      }
      if (url === `${DAEMON_URL}/api/artifacts?chatId=chat-1`) {
        return jsonResponse({ artifacts: [ok, bad] });
      }
      if (url === `${DAEMON_URL}/api/artifacts/art-ok/content`) {
        return bytesResponse("good");
      }
      if (url === `${DAEMON_URL}/api/artifacts/art-bad/content`) {
        return new Response("boom", { status: 500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();
    const zip = await decodeZip(res);
    expect(await zip.file("assets/artifacts/art-ok/ok.txt")?.async("string")).toBe("good");
    expect(zip.file("assets/artifacts/art-bad/bad.txt")).toBeNull();
    expectChatExportWarn(warn);
  });

  it("returns 499 when the request is already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();
    stubDaemonFetch((_url, init) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      throw new Error("expected aborted signal");
    });

    const res = await callExport({ signal: abortController.signal });

    expect(res.status).toBe(499);
  });

  it("returns 504 when the overall export budget elapses", async () => {
    // Use fake timers to fast-forward past EXPORT_BUDGET_MS without the
    // test actually waiting 60s. The chat fetch hangs until the budget's
    // AbortSignal.timeout fires; the route then maps that to a 504.
    vi.useFakeTimers();
    try {
      stubDaemonFetch(async (_url, init) => {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("timeout", "TimeoutError")),
          );
        });
      });

      const resPromise = callExport();
      await vi.advanceTimersByTimeAsync(EXPORT_BUDGET_MS + 1);
      const res = await resPromise;

      expect(res.status).toBe(504);
      expect(await res.json()).toEqual({
        error: "Export timed out",
        limitMs: EXPORT_BUDGET_MS,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops an artifact whose body exceeds the byte ceiling despite a small declared size", async () => {
    const warn = silenceChatExportWarn();
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
    expectChatExportWarn(warn);
  });

  it("scrubs /home/* and C:\\Users\\* prefixes from chat.json in addition to /Users/*", async () => {
    // The happy-path test covers `/Users/...`. The other two replacements
    // are unexercised there; this case pins them so a regression that
    // accidentally narrows the regex (or drops a branch from
    // `scrubHomePaths`) fails here.
    //
    // The fixture path values use single-backslash Windows paths, matching
    // the real on-the-wire shape from `run_code` and similar tools. When
    // the route runs `JSON.stringify` to serialise the response, each `\`
    // is doubled to `\\` — which is the form `scrubHomePaths`'s regex
    // (`/C:\\\\Users\\\\[^\\\\\\s"'<>]+/`) matches.
    stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return jsonResponse({
          chat: sampleChat().chat,
          messages: [
            {
              id: "m1",
              role: "assistant",
              parts: [
                {
                  type: "tool-run_code",
                  output: {
                    linuxPath: "/home/bob/work/repo",
                    // Single-backslash path. JS literal `"C:\\Users\\carol"`
                    // is the four-character runtime value `C:\Users\carol`.
                    winPath: "C:\\Users\\carol\\Documents",
                  },
                },
              ],
            },
          ],
          systemPromptContext: null,
        });
      }
      if (url === `${DAEMON_URL}/api/artifacts?chatId=chat-1`) {
        return jsonResponse({ artifacts: [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();
    const zip = await decodeZip(res);
    const chatJson = (await zip.file("chat.json")?.async("string")) ?? "";
    expect(chatJson).not.toMatch(/\/home\/bob\b/);
    expect(chatJson).toContain("/home/~/work/repo");
    // After JSON.stringify the original `\` becomes `\\` in the wire
    // output, so the scrubbed-form check looks for `C:\\Users\\~`.
    expect(chatJson).not.toMatch(/C:\\\\Users\\\\carol/);
    expect(chatJson).toContain("C:\\\\Users\\\\~");
  });
});

describe("chat export — post-fetch aggregate ceiling", () => {
  // The pre-fetch (declared-size) 413 is covered above. This branch
  // catches artifacts that *lied* about their declared size: each fits
  // under the per-artifact cap but the running total still trips the
  // aggregate cap *after* the bytes have been read. Streamed bodies keep
  // peak test memory bounded.
  beforeEach(() => {
    // Per-artifact cap is 25 MiB, aggregate cap 250 MiB. Eleven artifacts
    // each returning 25 MiB exactly fits the per-artifact cap but sums to
    // 275 MiB, which trips the post-fetch 413.
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns 413 when downloaded bytes cross the aggregate ceiling mid-stream", async () => {
    const warn = silenceChatExportWarn();
    // 11 artifacts, each declared 1 KB so the pre-fetch sum (11 KB) is
    // well under the aggregate cap; each body returns 25 MiB which lands
    // under the per-artifact cap but pushes the post-fetch running total
    // past 250 MiB once we read past the tenth.
    const artifacts = Array.from({ length: 11 }, (_, idx) =>
      sampleArtifact(`art-${idx}`, { size: 1024 }),
    );

    const makeBody = (): ReadableStream<Uint8Array> => {
      const chunk = new Uint8Array(1024 * 1024); // 1 MiB
      let emitted = 0;
      const target = 25 * 1024 * 1024;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted >= target) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
          emitted += chunk.byteLength;
        },
      });
    };

    stubDaemonFetch((url) => {
      if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/chat-1?full=true`) {
        return jsonResponse(sampleChat());
      }
      if (url === `${DAEMON_URL}/api/artifacts?chatId=chat-1`) {
        return jsonResponse({ artifacts });
      }
      if (url.includes("/api/artifacts/") && url.endsWith("/content")) {
        return bytesResponse(makeBody());
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await callExport();
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; totalBytes: number; limit: number };
    expect(body.error).toBe("Export exceeds size limit");
    expect(body.limit).toBe(MAX_TOTAL_ARTIFACT_BYTES);
    expect(body.totalBytes).toBeGreaterThan(MAX_TOTAL_ARTIFACT_BYTES);
    // `warn` may or may not have fired depending on how many artifacts
    // were processed before the 413; restore it without asserting so the
    // test does not flap.
    warn.mockRestore();
  }, 30_000);
});
