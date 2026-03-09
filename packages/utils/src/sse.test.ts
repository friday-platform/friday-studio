import { describe, expect, it } from "vitest";
import { parseSSEMessage, parseSSEStream } from "./sse.ts";

describe("parseSSEMessage", () => {
  it("parses a data-only message", () => {
    const result = parseSSEMessage('data: {"type":"hello"}');
    expect(result).toEqual({ data: '{"type":"hello"}' });
  });

  it("parses a message with event and data", () => {
    const result = parseSSEMessage('event: ephemeral\ndata: {"chunk":1}');
    expect(result).toEqual({ event: "ephemeral", data: '{"chunk":1}' });
  });

  it("concatenates multi-line data fields", () => {
    const result = parseSSEMessage("data: line1\ndata: line2");
    expect(result).toEqual({ data: "line1\nline2" });
  });

  it("returns null for empty message", () => {
    expect(parseSSEMessage("")).toBeNull();
  });

  it("returns null for comment-only message", () => {
    expect(parseSSEMessage(": keepalive")).toBeNull();
  });

  it("ignores id and retry fields", () => {
    const result = parseSSEMessage("id: 42\nretry: 5000\ndata: payload");
    expect(result).toEqual({ data: "payload" });
  });

  it("trims whitespace from data values", () => {
    const result = parseSSEMessage("data:   spaced  ");
    expect(result).toEqual({ data: "spaced" });
  });

  it("trims whitespace from event values", () => {
    const result = parseSSEMessage("event:  custom \ndata: x");
    expect(result).toEqual({ event: "custom", data: "x" });
  });

  it("parses CRLF-separated fields", () => {
    const result = parseSSEMessage("event: test\r\ndata: payload");
    expect(result).toEqual({ event: "test", data: "payload" });
  });

  it("parses CR-separated fields", () => {
    const result = parseSSEMessage("event: test\rdata: payload");
    expect(result).toEqual({ event: "test", data: "payload" });
  });

  it("handles mixed line endings", () => {
    const result = parseSSEMessage("event: mixed\r\ndata: line1\rdata: line2\ndata: line3");
    expect(result).toEqual({ event: "mixed", data: "line1\nline2\nline3" });
  });
});

describe("parseSSEStream", () => {
  function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
  }

  it("parses a single complete message", async () => {
    const stream = makeStream(['data: {"id":1}\n\n']);
    const messages = [];
    for await (const msg of parseSSEStream(stream)) {
      messages.push(msg);
    }
    expect(messages).toEqual([{ data: '{"id":1}' }]);
  });

  it("parses multiple messages in one chunk", async () => {
    const stream = makeStream(["data: first\n\ndata: second\n\n"]);
    const messages = [];
    for await (const msg of parseSSEStream(stream)) {
      messages.push(msg);
    }
    expect(messages).toEqual([{ data: "first" }, { data: "second" }]);
  });

  it("handles messages split across chunks", async () => {
    const stream = makeStream(["data: spl", "it-msg\n\n"]);
    const messages = [];
    for await (const msg of parseSSEStream(stream)) {
      messages.push(msg);
    }
    expect(messages).toEqual([{ data: "split-msg" }]);
  });

  it("handles boundary split across chunks", async () => {
    const stream = makeStream(["data: msg\n", "\ndata: next\n\n"]);
    const messages = [];
    for await (const msg of parseSSEStream(stream)) {
      messages.push(msg);
    }
    expect(messages).toEqual([{ data: "msg" }, { data: "next" }]);
  });

  it("skips comment-only messages", async () => {
    const stream = makeStream([": keepalive\n\ndata: real\n\n"]);
    const messages = [];
    for await (const msg of parseSSEStream(stream)) {
      messages.push(msg);
    }
    expect(messages).toEqual([{ data: "real" }]);
  });

  it("preserves event field", async () => {
    const stream = makeStream(["event: ephemeral\ndata: chunk\n\n"]);
    const messages = [];
    for await (const msg of parseSSEStream(stream)) {
      messages.push(msg);
    }
    expect(messages).toEqual([{ event: "ephemeral", data: "chunk" }]);
  });

  it("handles empty stream", async () => {
    const stream = makeStream([]);
    const messages = [];
    for await (const msg of parseSSEStream(stream)) {
      messages.push(msg);
    }
    expect(messages).toEqual([]);
  });

  it("discards trailing partial message without boundary", async () => {
    const stream = makeStream(["data: complete\n\ndata: partial"]);
    const messages = [];
    for await (const msg of parseSSEStream(stream)) {
      messages.push(msg);
    }
    expect(messages).toEqual([{ data: "complete" }]);
  });

  it("handles CRLF message boundaries", async () => {
    const stream = makeStream(["data: first\r\n\r\ndata: second\r\n\r\n"]);
    const messages = [];
    for await (const msg of parseSSEStream(stream)) {
      messages.push(msg);
    }
    expect(messages).toEqual([{ data: "first" }, { data: "second" }]);
  });

  it("handles CR message boundaries", async () => {
    const stream = makeStream(["data: first\r\rdata: second\r\r"]);
    const messages = [];
    for await (const msg of parseSSEStream(stream)) {
      messages.push(msg);
    }
    expect(messages).toEqual([{ data: "first" }, { data: "second" }]);
  });

  it("handles mixed boundaries across chunks", async () => {
    const stream = makeStream(["data: one\r\n\r\ndata: tw", "o\r\rdata: three\n\n"]);
    const messages = [];
    for await (const msg of parseSSEStream(stream)) {
      messages.push(msg);
    }
    expect(messages).toEqual([{ data: "one" }, { data: "two" }, { data: "three" }]);
  });
});
