import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "$lib/server/metrics";
import { handle, handleError } from "./hooks.server";

function makeEvent(overrides: {
  pathname?: string;
  method?: string;
  routeId?: string | null;
  locals?: Record<string, unknown>;
}) {
  const url = new URL(overrides.pathname ?? "/", "http://localhost");
  const locals: Record<string, unknown> = overrides.locals ?? {};
  return {
    url,
    request: new Request(url, { method: overrides.method ?? "GET" }),
    route: { id: overrides.routeId === undefined ? "/" : overrides.routeId },
    getClientAddress: () => "127.0.0.1",
    locals,
  };
}

function makeResolve(status = 200) {
  return vi.fn().mockResolvedValue(new Response(null, { status }));
}

describe("handle hook", () => {
  afterAll(() => {
    registry.clear();
  });

  beforeEach(() => {
    registry.resetMetrics();
  });

  it("records histogram with correct labels for normal requests", async () => {
    const event = makeEvent({ pathname: "/", method: "GET", routeId: "/" });
    const resolve = makeResolve(200);

    await handle({ event, resolve } as never);

    const text = await registry.metrics();
    expect(text).toContain(
      'http_request_duration_seconds_count{service="friday-website",method="GET",route="/",status="200"} 1',
    );
  });

  it("skips histogram and logging for /metrics path", async () => {
    const event = makeEvent({ pathname: "/metrics", routeId: "/metrics" });
    const resolve = makeResolve(200);

    await handle({ event, resolve } as never);

    const text = await registry.metrics();
    expect(text).not.toContain('route="/metrics"');
  });

  it("uses (unmatched) for null route IDs", async () => {
    const event = makeEvent({ pathname: "/nonexistent", routeId: null });
    const resolve = makeResolve(404);

    await handle({ event, resolve } as never);

    const text = await registry.metrics();
    expect(text).toContain('route="(unmatched)"');
  });

  it("records duration in seconds", async () => {
    const event = makeEvent({});
    const resolve = makeResolve(200);

    await handle({ event, resolve } as never);

    const text = await registry.metrics();
    // Duration should be tiny (< 0.1s) so it lands in the smallest buckets
    expect(text).toMatch(/http_request_duration_seconds_bucket\{.*le="0\.01".*\} 1/);
  });
});

describe("handleError", () => {
  it("stashes Error details on event.locals", () => {
    const event = makeEvent({});
    const error = new Error("test failure");

    const result = handleError({ error, event, status: 500, message: "Internal Error" } as never);

    expect(event.locals.error).toBe("test failure");
    expect(event.locals.stack).toContain("test failure");
    expect(result).toEqual({ message: "Internal Error" });
  });

  it("stashes non-Error values as strings on event.locals", () => {
    const event = makeEvent({});

    const result = handleError({
      error: "string error",
      event,
      status: 500,
      message: "Internal Error",
    } as never);

    expect(event.locals.error).toBe("string error");
    expect(event.locals.stack).toBeUndefined();
    expect(result).toEqual({ message: "Internal Error" });
  });
});
