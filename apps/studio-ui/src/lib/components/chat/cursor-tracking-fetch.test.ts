import { describe, expect, it } from "vitest";
import {
  createCursorTracker,
  createCursorTrackingFetch,
} from "./cursor-tracking-fetch.ts";

// ---------------------------------------------------------------------------
// Helpers — feed hand-chunked SSE byte sequences through the TransformStream
// and observe what the cursor cell ends up with. The tracker forwards bytes
// untouched, so collecting `forwarded` lets us assert pass-through behavior
// alongside cursor-commit timing.
// ---------------------------------------------------------------------------

function makeCursor() {
  let value: number | undefined;
  return {
    get: () => value,
    set: (v: number) => {
      value = v;
    },
  };
}

async function runTracker(
  chunks: ReadonlyArray<string>,
): Promise<{ cursor: number | undefined; forwarded: string }> {
  const cursor = makeCursor();
  const tracker = createCursorTracker({ getCursor: cursor.get, setCursor: cursor.set });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const writer = tracker.writable.getWriter();
  const reader = tracker.readable.getReader();
  let forwarded = "";

  const drain = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      forwarded += decoder.decode(value, { stream: true });
    }
    forwarded += decoder.decode();
  })();

  for (const chunk of chunks) {
    await writer.write(encoder.encode(chunk));
  }
  await writer.close();
  await drain;

  return { cursor: cursor.get(), forwarded };
}

describe("createCursorTracker", () => {
  // (a) commit-on-terminator
  it("commits the cursor only after the event terminator is forwarded", async () => {
    const cursor = makeCursor();
    const tracker = createCursorTracker({ getCursor: cursor.get, setCursor: cursor.set });
    const encoder = new TextEncoder();
    const writer = tracker.writable.getWriter();
    const reader = tracker.readable.getReader();

    // Drain in the background so write() backpressure resolves promptly.
    const drain = (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    })();

    // Step 1: feed only the `id:` line — cursor must NOT advance yet, even
    // though the id has been parsed. This is the race the wrapper exists
    // to prevent: a connection drop here leaves the AI SDK without the
    // event's `data:` payload, but the cursor would advance regardless.
    await writer.write(encoder.encode("id: 7\n"));
    expect(cursor.get()).toBeUndefined();

    // Step 2: feed `data:` line — still pre-terminator, still no commit.
    await writer.write(encoder.encode('data: {"x":1}\n'));
    expect(cursor.get()).toBeUndefined();

    // Step 3: feed terminator — cursor commits.
    await writer.write(encoder.encode("\n"));
    expect(cursor.get()).toBe(7);

    await writer.close();
    await drain;
  });

  // (b) chunk split between `id:` line and `data:` line
  it("survives a chunk split between the id line and the data line", async () => {
    const { cursor, forwarded } = await runTracker([
      "id: 3\n",
      'data: {"y":2}\n\n',
    ]);
    expect(cursor).toBe(3);
    expect(forwarded).toBe('id: 3\ndata: {"y":2}\n\n');
  });

  // (c) chunk split mid-`id:` line
  it("survives a chunk split mid-id line", async () => {
    const { cursor, forwarded } = await runTracker([
      "id",
      ": 4",
      "2\n",
      'data: {"k":3}\n\n',
    ]);
    expect(cursor).toBe(42);
    expect(forwarded).toBe('id: 42\ndata: {"k":3}\n\n');
  });

  // (d) replay-disabled stream with no `id:` lines
  it("leaves the cursor untouched when the stream emits no id lines", async () => {
    const { cursor, forwarded } = await runTracker([
      'data: {"replay":"disabled"}\n\n',
      'data: {"k":"v"}\n\n',
    ]);
    expect(cursor).toBeUndefined();
    expect(forwarded).toBe('data: {"replay":"disabled"}\n\ndata: {"k":"v"}\n\n');
  });

  // (e) cursor monotonicity — lower id must not regress
  it("never regresses the cursor when a lower id appears", async () => {
    const cursor = makeCursor();
    cursor.set(10);
    const tracker = createCursorTracker({ getCursor: cursor.get, setCursor: cursor.set });
    const encoder = new TextEncoder();
    const writer = tracker.writable.getWriter();
    const reader = tracker.readable.getReader();

    const drain = (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    })();

    await writer.write(encoder.encode('id: 3\ndata: {}\n\n'));
    await writer.close();
    await drain;

    expect(cursor.get()).toBe(10);
  });

  it("advances the cursor across multiple events, keeping the highest id", async () => {
    const { cursor } = await runTracker([
      'id: 1\ndata: a\n\n',
      'id: 2\ndata: b\n\n',
      'id: 3\ndata: c\n\n',
    ]);
    expect(cursor).toBe(3);
  });

  it("ignores non-numeric and negative id values", async () => {
    const { cursor } = await runTracker([
      'id: abc\ndata: a\n\n',
      'id: -1\ndata: b\n\n',
    ]);
    expect(cursor).toBeUndefined();
  });

  it("strips a trailing CR so CRLF terminators still commit", async () => {
    const { cursor } = await runTracker(["id: 5\r\ndata: x\r\n\r\n"]);
    expect(cursor).toBe(5);
  });

  it("forwards bytes unchanged across arbitrary chunk boundaries", async () => {
    const payload = 'id: 9\ndata: {"a":1}\n\nid: 10\ndata: {"b":2}\n\n';
    const chunks = Array.from(payload).map((c) => c);
    const { forwarded, cursor } = await runTracker(chunks);
    expect(forwarded).toBe(payload);
    expect(cursor).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// createCursorTrackingFetch — behavior at the request/response boundary.
// We swap in a fake fetch so tests don't touch the network and can assert
// header injection + null-body short-circuiting precisely.
// ---------------------------------------------------------------------------

function makeBodyStream(body: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
}

describe("createCursorTrackingFetch", () => {
  it("attaches Last-Event-ID on resume requests when a cursor is set", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      captured = init;
      return Promise.resolve(new Response(makeBodyStream(""), { status: 200 }));
    };

    const tracking = createCursorTrackingFetch({
      getCursor: () => 42,
      setCursor: () => {},
      isResumeRequest: () => true,
      fetchImpl,
    });

    await tracking("https://example.test/stream");
    const headers = new Headers(captured?.headers);
    expect(headers.get("Last-Event-ID")).toBe("42");
  });

  it("omits Last-Event-ID on non-resume requests", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      captured = init;
      return Promise.resolve(new Response(makeBodyStream(""), { status: 200 }));
    };

    const tracking = createCursorTrackingFetch({
      getCursor: () => 42,
      setCursor: () => {},
      isResumeRequest: () => false,
      fetchImpl,
    });

    await tracking("https://example.test/chat", { method: "POST" });
    const headers = new Headers(captured?.headers);
    expect(headers.has("Last-Event-ID")).toBe(false);
  });

  it("omits Last-Event-ID when no cursor is set, even on resume requests", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      captured = init;
      return Promise.resolve(new Response(makeBodyStream(""), { status: 200 }));
    };

    const tracking = createCursorTrackingFetch({
      getCursor: () => undefined,
      setCursor: () => {},
      isResumeRequest: () => true,
      fetchImpl,
    });

    await tracking("https://example.test/stream");
    const headers = new Headers(captured?.headers);
    expect(headers.has("Last-Event-ID")).toBe(false);
  });

  it("returns the original Response unwrapped on 204 (null-body status)", async () => {
    // `new Response(stream, {status: 204})` throws — so the wrapper must
    // short-circuit. The resume endpoint returns 204 when the chat is
    // already finished; rehydrate hits this path on every reload of a
    // completed conversation.
    const original = new Response(null, { status: 204 });
    const fetchImpl: typeof fetch = () => Promise.resolve(original);

    const tracking = createCursorTrackingFetch({
      getCursor: () => undefined,
      setCursor: () => {},
      isResumeRequest: () => true,
      fetchImpl,
    });

    const result = await tracking("https://example.test/stream");
    expect(result).toBe(original);
    expect(result.status).toBe(204);
  });

  it("returns the original Response unwrapped on non-2xx responses", async () => {
    const original = new Response(makeBodyStream("nope"), { status: 500 });
    const fetchImpl: typeof fetch = () => Promise.resolve(original);

    const tracking = createCursorTrackingFetch({
      getCursor: () => undefined,
      setCursor: () => {},
      isResumeRequest: () => true,
      fetchImpl,
    });

    const result = await tracking("https://example.test/stream");
    expect(result).toBe(original);
  });

  it("pipes the body through the cursor tracker on success", async () => {
    let cursorValue: number | undefined;
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(makeBodyStream("id: 11\ndata: hi\n\n"), { status: 200 }),
      );

    const tracking = createCursorTrackingFetch({
      getCursor: () => cursorValue,
      setCursor: (v) => {
        cursorValue = v;
      },
      isResumeRequest: () => false,
      fetchImpl,
    });

    const response = await tracking("https://example.test/chat");
    // Drain the body so the tracker actually runs.
    const text = await response.text();
    expect(text).toBe("id: 11\ndata: hi\n\n");
    expect(cursorValue).toBe(11);
  });

  it("fires onUnrecoverable on 410 + X-Stream-Replay-Disabled", async () => {
    // Server returns this when the SSE buffer overflowed and replay is
    // impossible. Without short-circuiting, the auto-resume effect would
    // burn its 20-attempt budget hammering the same dead endpoint.
    const original = new Response(null, {
      status: 410,
      headers: { "X-Stream-Replay-Disabled": "true" },
    });
    const fetchImpl: typeof fetch = () => Promise.resolve(original);

    let unrecoverable = 0;
    const tracking = createCursorTrackingFetch({
      getCursor: () => 5,
      setCursor: () => {},
      isResumeRequest: () => true,
      onUnrecoverable: () => {
        unrecoverable += 1;
      },
      fetchImpl,
    });

    const result = await tracking("https://example.test/stream");
    expect(result.status).toBe(410);
    expect(unrecoverable).toBe(1);
  });

  it("does not fire onUnrecoverable on 410 without the marker header", async () => {
    const original = new Response(null, { status: 410 });
    const fetchImpl: typeof fetch = () => Promise.resolve(original);

    let unrecoverable = 0;
    const tracking = createCursorTrackingFetch({
      getCursor: () => undefined,
      setCursor: () => {},
      isResumeRequest: () => true,
      onUnrecoverable: () => {
        unrecoverable += 1;
      },
      fetchImpl,
    });

    await tracking("https://example.test/stream");
    expect(unrecoverable).toBe(0);
  });

  it("does not fire onUnrecoverable on other non-2xx statuses", async () => {
    const original = new Response(makeBodyStream("nope"), {
      status: 500,
      headers: { "X-Stream-Replay-Disabled": "true" },
    });
    const fetchImpl: typeof fetch = () => Promise.resolve(original);

    let unrecoverable = 0;
    const tracking = createCursorTrackingFetch({
      getCursor: () => undefined,
      setCursor: () => {},
      isResumeRequest: () => true,
      onUnrecoverable: () => {
        unrecoverable += 1;
      },
      fetchImpl,
    });

    await tracking("https://example.test/stream");
    expect(unrecoverable).toBe(0);
  });

  it("accepts URL and Request inputs for the resume predicate", async () => {
    const seen: Array<Request | URL | string> = [];
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response(makeBodyStream(""), { status: 200 }));

    const tracking = createCursorTrackingFetch({
      getCursor: () => 1,
      setCursor: () => {},
      isResumeRequest: (input) => {
        seen.push(input);
        return false;
      },
      fetchImpl,
    });

    const url = new URL("https://example.test/stream");
    const req = new Request("https://example.test/chat");
    await tracking("https://example.test/x");
    await tracking(url);
    await tracking(req);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe("https://example.test/x");
    expect(seen[1]).toBe(url);
    expect(seen[2]).toBe(req);
  });
});
