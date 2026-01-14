import { assertEquals, assertRejects } from "@std/assert";
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

Deno.test("postSlackMessage posts to Slack API", async () => {
  const mock = mockFetch({ ok: true });
  try {
    await postSlackMessage({ token: "xoxb-test", channel: "C123", text: "Hello" });

    assertEquals(mock.calls.length, 1);
    assertEquals(mock.calls[0]?.url, "https://slack.com/api/chat.postMessage");
  } finally {
    mock.restore();
  }
});

Deno.test("postSlackMessage includes thread_ts when provided", async () => {
  const mock = mockFetch({ ok: true });
  try {
    await postSlackMessage({
      token: "xoxb-test",
      channel: "C123",
      text: "Reply",
      threadTs: "1234567890.123456",
    });

    const firstCall = mock.calls[0];
    if (!firstCall) throw new Error("Expected fetch to be called");
    const body = JSON.parse(firstCall.init?.body as string) as { thread_ts: string };
    assertEquals(body.thread_ts, "1234567890.123456");
  } finally {
    mock.restore();
  }
});

Deno.test("postSlackMessage throws on Slack API error", async () => {
  const mock = mockFetch({ ok: false, error: "channel_not_found" });
  try {
    await assertRejects(
      () => postSlackMessage({ token: "xoxb-test", channel: "C123", text: "Hello" }),
      Error,
      "channel_not_found",
    );
  } finally {
    mock.restore();
  }
});
