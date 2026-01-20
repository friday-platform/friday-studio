import { afterEach, describe, expect, it } from "vitest";
import { postSlackMessage } from "./slack-client.ts";

// Mock fetch helper
function mockFetch(response: { ok: boolean; error?: string }) {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit | undefined }[] = [];

  globalThis.fetch = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url.toString(), init });
    return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("postSlackMessage", () => {
  let mock: ReturnType<typeof mockFetch> | null = null;

  afterEach(() => {
    mock?.restore();
  });

  it("posts to Slack API", async () => {
    mock = mockFetch({ ok: true });
    await postSlackMessage({ token: "xoxb-test", channel: "C123", text: "Hello" });

    expect(mock.calls.length).toEqual(1);
    expect(mock.calls[0]?.url).toEqual("https://slack.com/api/chat.postMessage");
  });

  it("includes thread_ts when provided", async () => {
    mock = mockFetch({ ok: true });
    await postSlackMessage({
      token: "xoxb-test",
      channel: "C123",
      text: "Reply",
      threadTs: "1234567890.123456",
    });

    const firstCall = mock.calls[0];
    if (!firstCall) throw new Error("Expected fetch to be called");
    const body = JSON.parse(firstCall.init?.body as string) as { thread_ts: string };
    expect(body.thread_ts).toEqual("1234567890.123456");
  });

  it("throws on Slack API error", async () => {
    mock = mockFetch({ ok: false, error: "channel_not_found" });
    await expect(
      postSlackMessage({ token: "xoxb-test", channel: "C123", text: "Hello" }),
    ).rejects.toThrow("channel_not_found");
  });
});
