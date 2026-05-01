import { describe, expect, test } from "vitest";
import { transformInput } from "./format-middleware.ts";

/**
 * The middleware's interesting logic lives in transformInput. The
 * wrapGenerate/wrapStream handlers are just plumbing that call it
 * on the `input` field of matching tool-call content parts.
 */

describe("transformInput (upstream slack-mcp-server — `text` param)", () => {
  test("converts bold markdown to Slack mrkdwn", () => {
    const input = JSON.stringify({
      channel_id: "C123",
      text: "Hello **world**",
      content_type: "text/markdown",
    });

    const out = JSON.parse(transformInput(input)) as {
      text: string;
      content_type: string;
      channel_id: string;
    };

    expect(out.text).toBe("Hello *world*");
    expect(out.content_type).toBe("text/plain");
    expect(out.channel_id).toBe("C123");
  });

  test("converts links to Slack format", () => {
    const input = JSON.stringify({
      channel_id: "C123",
      text: "See [docs](https://example.com) for details",
    });

    const out = JSON.parse(transformInput(input)) as { text: string };

    expect(out.text).toBe("See <https://example.com|docs> for details");
  });

  test("converts strikethrough (a GFM feature slack-mcp-server drops)", () => {
    const input = JSON.stringify({ channel_id: "C123", text: "Status: ~~broken~~ fixed" });

    const out = JSON.parse(transformInput(input)) as { text: string };

    expect(out.text).toBe("Status: ~broken~ fixed");
  });

  test("preserves unknown keys (thread_ts, channel_id, etc.)", () => {
    const input = JSON.stringify({
      channel_id: "C123",
      thread_ts: "1234567890.123456",
      text: "reply text",
    });

    const out = JSON.parse(transformInput(input)) as Record<string, unknown>;

    expect(out.channel_id).toBe("C123");
    expect(out.thread_ts).toBe("1234567890.123456");
    expect(out.text).toBe("reply text");
    expect(out.content_type).toBe("text/plain");
  });

  test("forces content_type to text/plain so MCP server does not double-convert", () => {
    const input = JSON.stringify({ channel_id: "C123", text: "Hi", content_type: "text/markdown" });

    const out = JSON.parse(transformInput(input)) as { content_type: string };

    expect(out.content_type).toBe("text/plain");
  });
});

describe("transformInput (fork fallback — `payload` param)", () => {
  test("converts bold when only `payload` is present", () => {
    const input = JSON.stringify({ channel_id: "C123", payload: "Hello **world**" });

    const out = JSON.parse(transformInput(input)) as { payload: string; content_type: string };

    expect(out.payload).toBe("Hello *world*");
    expect(out.content_type).toBe("text/plain");
  });

  test("prefers `text` over `payload` when both are present", () => {
    const input = JSON.stringify({
      channel_id: "C123",
      text: "canonical **value**",
      payload: "legacy value",
    });

    const out = JSON.parse(transformInput(input)) as { text: string; payload: string };

    expect(out.text).toBe("canonical *value*");
    expect(out.payload).toBe("legacy value"); // untouched
  });
});

describe("transformInput (failure modes)", () => {
  test("fails open on malformed JSON", () => {
    expect(transformInput("this is not json")).toBe("this is not json");
  });

  test("fails open when neither text nor payload is present", () => {
    const input = JSON.stringify({ channel_id: "C123" });
    expect(transformInput(input)).toBe(input);
  });

  test("fails open when body field is not a string", () => {
    const input = JSON.stringify({ channel_id: "C123", text: 42 });
    expect(transformInput(input)).toBe(input);
  });
});
