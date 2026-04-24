/**
 * Unit tests for @atlas/sdk-ts agent SDK.
 * Tests handler registration, ok/err result builders, and context capability
 * wiring without requiring a live NATS server.
 */

import type { NatsConnection } from "nats";
import { describe, expect, test, vi } from "vitest";
import { buildContext } from "../src/context.ts";
import { err, ok } from "../src/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockNats(): NatsConnection {
  return {
    request: vi.fn<() => Promise<{ data: Uint8Array }>>(),
    publish: vi.fn<() => void>(),
    subscribe: vi.fn(),
    drain: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as NatsConnection;
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    env: { FOO: "bar" },
    config: { model: "claude-3-5-sonnet" },
    session: {
      id: "sess-1",
      workspace_id: "ws-1",
      user_id: "user-1",
      datetime: "2026-01-01T00:00:00Z",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ok / err builders
// ---------------------------------------------------------------------------

describe("ok()", () => {
  test("wraps data in tag:ok result", () => {
    const result = ok("hello");
    expect(result.tag).toBe("ok");
    expect(JSON.parse(result.val)).toMatchObject({ data: "hello" });
  });

  test("includes extras when provided", () => {
    const result = ok({ answer: 42 }, { reasoning: "deep thought" });
    const parsed = JSON.parse(result.val) as Record<string, unknown>;
    expect(parsed.data).toEqual({ answer: 42 });
    expect(parsed.reasoning).toBe("deep thought");
  });

  test("omits undefined extras fields", () => {
    const result = ok("x", { artifactRefs: undefined });
    const parsed = JSON.parse(result.val) as Record<string, unknown>;
    expect("artifactRefs" in parsed).toBe(false);
  });
});

describe("err()", () => {
  test("wraps message in tag:err result", () => {
    const result = err("something went wrong");
    expect(result.tag).toBe("err");
    expect(result.val).toBe("something went wrong");
  });
});

// ---------------------------------------------------------------------------
// buildContext — session parsing
// ---------------------------------------------------------------------------

describe("buildContext session", () => {
  test("parses session fields from snake_case keys", () => {
    const nc = mockNats();
    const ctx = buildContext(makeRaw(), nc, "sess-1");
    expect(ctx.session).toMatchObject({
      id: "sess-1",
      workspaceId: "ws-1",
      userId: "user-1",
      datetime: "2026-01-01T00:00:00Z",
    });
  });

  test("falls back gracefully when session is missing", () => {
    const nc = mockNats();
    const ctx = buildContext({ env: {}, config: {} }, nc, "sess-2");
    expect(ctx.session.id).toBe("sess-2");
    expect(ctx.session.workspaceId).toBe("");
  });

  test("propagates env as string map", () => {
    const nc = mockNats();
    const ctx = buildContext(makeRaw({ env: { X: "1", Y: "2" } }), nc, "s");
    expect(ctx.env).toEqual({ X: "1", Y: "2" });
  });
});

// ---------------------------------------------------------------------------
// buildContext — capability calls
// ---------------------------------------------------------------------------

describe("buildContext capabilities", () => {
  test("llm.generate sends request to caps.{sessionId}.llm.generate", async () => {
    const nc = mockNats();
    const responsePayload = { text: "pong", model: "claude", usage: {}, finish_reason: "stop" };
    vi.mocked(nc.request).mockResolvedValue({ data: encode(JSON.stringify(responsePayload)) });

    const ctx = buildContext(makeRaw(), nc, "sess-abc");
    const result = await ctx.llm.generate({ messages: [{ role: "user", content: "ping" }] });

    expect(nc.request).toHaveBeenCalledWith(
      "caps.sess-abc.llm.generate",
      expect.any(Uint8Array),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(result).toMatchObject({ text: "pong" });
  });

  test("llm.generate throws on error response", async () => {
    const nc = mockNats();
    vi.mocked(nc.request).mockResolvedValue({
      data: encode(JSON.stringify({ error: "rate limited" })),
    });

    const ctx = buildContext(makeRaw(), nc, "sess-abc");
    await expect(ctx.llm.generate({})).rejects.toThrow("rate limited");
  });

  test("tools.list returns parsed tool definitions", async () => {
    const nc = mockNats();
    const tools = [
      { name: "read_file", description: "Reads a file", inputSchema: { type: "object" } },
    ];
    vi.mocked(nc.request).mockResolvedValue({ data: encode(JSON.stringify({ tools })) });

    const ctx = buildContext(makeRaw(), nc, "sess-t");
    const result = await ctx.tools.list();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "read_file", description: "Reads a file" });
  });

  test("tools.call sends name+args to caps.{sessionId}.tools.call", async () => {
    const nc = mockNats();
    vi.mocked(nc.request).mockResolvedValue({ data: encode(JSON.stringify({ result: "ok" })) });

    const ctx = buildContext(makeRaw(), nc, "sess-c");
    const result = await ctx.tools.call("write_file", { path: "/tmp/x", content: "hello" });

    expect(nc.request).toHaveBeenCalledWith(
      "caps.sess-c.tools.call",
      expect.any(Uint8Array),
      expect.any(Object),
    );
    expect(result).toMatchObject({ result: "ok" });
  });

  test("stream.emit publishes to sessions.{sessionId}.events", () => {
    const nc = mockNats();
    const ctx = buildContext(makeRaw(), nc, "sess-s");

    ctx.stream.emit("step:output", { text: "hello" });

    expect(nc.publish).toHaveBeenCalledWith("sessions.sess-s.events", expect.any(Uint8Array));
  });
});
