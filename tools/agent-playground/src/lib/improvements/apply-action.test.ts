import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptFinding, rejectFinding, dismissFinding } from "./apply-action.ts";

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
  it("posts disposition=accept with patch field", async () => {
    const result = await acceptFinding("f-1", "ws-alpha", "agents:\n  retries: 3");

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("/api/improvements/apply");

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
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
    const result = await rejectFinding("f-2", "ws-beta");

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      findingId: "f-2",
      workspaceId: "ws-beta",
      disposition: "reject",
    });
    expect(body).not.toHaveProperty("patch");
  });
});

describe("dismissFinding", () => {
  it("posts disposition=dismiss without patch", async () => {
    const result = await dismissFinding("f-3", "ws-gamma");

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      findingId: "f-3",
      workspaceId: "ws-gamma",
      disposition: "dismiss",
    });
    expect(body).not.toHaveProperty("patch");
  });
});
