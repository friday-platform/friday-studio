import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptFinding,
  rejectFinding,
  dismissFinding,
  rollbackFinding,
} from "./apply-action.ts";

const fetchSpy = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("acceptFinding", () => {
  it("tries lifecycle endpoint first, falls back on 404", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const result = await acceptFinding("f-1", "ws-alpha", "agents:\n  retries: 3");

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const firstUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(firstUrl).toContain("/api/improvements/f-1/approve");

    const secondUrl = String(fetchSpy.mock.calls[1]?.[0]);
    expect(secondUrl).toContain("/api/improvements/apply");
  });

  it("uses lifecycle result when endpoint succeeds", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, appliedVersion: "v2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await acceptFinding("f-1", "ws-alpha", "patch");

    expect(result.ok).toBe(true);
    expect(result.appliedVersion).toBe("v2");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("posts disposition=accept with patch field on fallback", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await acceptFinding("f-1", "ws-alpha", "agents:\n  retries: 3");

    const body = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      findingId: "f-1",
      workspaceId: "ws-alpha",
      disposition: "accept",
      patch: "agents:\n  retries: 3",
    });
  });
});

describe("rejectFinding", () => {
  it("posts disposition=reject without patch", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const result = await rejectFinding("f-2", "ws-beta");

    expect(result.ok).toBe(true);

    const body = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      findingId: "f-2",
      workspaceId: "ws-beta",
      disposition: "reject",
    });
    expect(body).not.toHaveProperty("patch");
  });
});

describe("dismissFinding", () => {
  it("posts disposition=dismiss without trying lifecycle endpoint", async () => {
    const result = await dismissFinding("f-3", "ws-gamma");

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("/api/improvements/apply");

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      findingId: "f-3",
      workspaceId: "ws-gamma",
      disposition: "dismiss",
    });
    expect(body).not.toHaveProperty("patch");
  });
});

describe("rollbackFinding", () => {
  it("tries lifecycle rollback endpoint first", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await rollbackFinding("f-4", "ws-delta");

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("/api/improvements/f-4/rollback");
  });

  it("falls back to apply endpoint on 404", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const result = await rollbackFinding("f-4", "ws-delta");

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const body = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      findingId: "f-4",
      workspaceId: "ws-delta",
      disposition: "rollback",
    });
  });
});
