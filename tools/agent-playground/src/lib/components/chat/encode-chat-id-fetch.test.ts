import { describe, expect, it } from "vitest";
import { wrapEncodeChatIdFetch } from "./encode-chat-id-fetch.ts";

const ok = () =>
  new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

/**
 * Build a fake inner fetch that records its first input. Typed signature
 * (instead of vi.fn) so the TS compiler can narrow `seen.input` without
 * tripping `noUncheckedIndexedAccess` on `mock.calls[0]`.
 */
function makeInner() {
  const seen: { input?: Request | URL | string; init?: RequestInit } = {};
  const fn = (input: Request | URL | string, init?: RequestInit) => {
    seen.input = input;
    seen.init = init;
    return Promise.resolve(ok());
  };
  return { fn, seen };
}

describe("wrapEncodeChatIdFetch", () => {
  it("re-encodes the chat-id segment when the id contains slashes", async () => {
    const { fn, seen } = makeInner();
    const fetchImpl = wrapEncodeChatIdFetch(fn, () => "github:owner/repo:issue:2");

    await fetchImpl("/api/daemon/api/workspaces/ws/chat/github:owner/repo:issue:2/stream");

    expect(seen.input).toBe(
      "/api/daemon/api/workspaces/ws/chat/github%3Aowner%2Frepo%3Aissue%3A2/stream",
    );
  });

  it("is a no-op for URL-safe chat ids", async () => {
    const { fn, seen } = makeInner();
    const fetchImpl = wrapEncodeChatIdFetch(fn, () => "chat_abc123");
    const url = "/api/daemon/api/workspaces/ws/chat/chat_abc123/stream";
    await fetchImpl(url);
    expect(seen.input).toBe(url);
  });

  it("is a no-op for URLs that don't contain the raw chat id", async () => {
    const { fn, seen } = makeInner();
    const fetchImpl = wrapEncodeChatIdFetch(fn, () => "github:owner/repo:issue:2");
    // No /chat/<rawId> segment — e.g. the POST send endpoint which carries id
    // in the body, not the URL.
    const url = "/api/daemon/api/workspaces/ws/chat";
    await fetchImpl(url);
    expect(seen.input).toBe(url);
  });

  it("rewrites URLs passed as URL objects", async () => {
    const { fn, seen } = makeInner();
    const fetchImpl = wrapEncodeChatIdFetch(fn, () => "github:owner/repo:issue:2");
    await fetchImpl(
      new URL(
        "http://localhost/api/daemon/api/workspaces/ws/chat/github:owner/repo:issue:2/stream",
      ),
    );
    expect(seen.input).toBeInstanceOf(URL);
    expect((seen.input as URL).pathname).toBe(
      "/api/daemon/api/workspaces/ws/chat/github%3Aowner%2Frepo%3Aissue%3A2/stream",
    );
  });

  it("rewrites URLs passed as Request objects and preserves init", async () => {
    const { fn, seen } = makeInner();
    const fetchImpl = wrapEncodeChatIdFetch(fn, () => "github:owner/repo:issue:2");
    const req = new Request(
      "http://localhost/api/daemon/api/workspaces/ws/chat/github:owner/repo:issue:2/stream",
      { method: "GET", headers: { "x-test": "1" } },
    );
    await fetchImpl(req);
    expect(seen.input).toBeInstanceOf(Request);
    const passed = seen.input as Request;
    expect(passed.url).toBe(
      "http://localhost/api/daemon/api/workspaces/ws/chat/github%3Aowner%2Frepo%3Aissue%3A2/stream",
    );
    expect(passed.headers.get("x-test")).toBe("1");
  });
});
