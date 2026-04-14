import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImprovementFinding } from "./improvement-finding.ts";
import { acceptFinding, dismissFinding, rejectFinding } from "./improvement-actions.ts";

function makeFinding(overrides?: Partial<ImprovementFinding>): ImprovementFinding {
  return {
    id: "finding-1",
    text: "Improve retry logic",
    createdAt: "2026-04-14T10:00:00Z",
    metadata: {
      kind: "improvement-finding",
      workspaceId: "ws-alpha",
      target_job_id: "job-a",
      proposed_diff: "--- a\n+++ b",
      proposed_full_config: "agents: {}",
      improvement_mode: "surface",
    },
    ...overrides,
  };
}

const fetchSpy = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("acceptFinding", () => {
  it("calls promote before posting to daemon apply", async () => {
    const callOrder: string[] = [];
    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/promote")) callOrder.push("promote");
      if (url.includes("/apply")) callOrder.push("apply");
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    await acceptFinding(makeFinding());

    expect(callOrder).toEqual(["promote", "apply"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("promotes with correct session key and target", async () => {
    await acceptFinding(makeFinding());

    const promoteCall = fetchSpy.mock.calls[0];
    expect(promoteCall).toBeDefined();
    const url = String(promoteCall?.[0]);
    expect(url).toContain("/api/scratchpad/improvement%3A%3Aws-alpha/promote");

    const body = JSON.parse(String(promoteCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      chunkId: "finding-1",
      target: { workspaceId: "ws-alpha", corpus: "notes" },
    });
  });

  it("posts correct payload to daemon apply", async () => {
    await acceptFinding(makeFinding());

    const applyCall = fetchSpy.mock.calls[1];
    expect(applyCall).toBeDefined();
    const url = String(applyCall?.[0]);
    expect(url).toContain("/api/daemon/apply");

    const body = JSON.parse(String(applyCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      findingId: "finding-1",
      workspaceId: "ws-alpha",
      target_job_id: "job-a",
    });
  });

  it("throws when apply endpoint returns error", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }));

    await expect(acceptFinding(makeFinding())).rejects.toThrow("Accept failed: 400");
  });
});

describe("rejectFinding", () => {
  it("posts to reject endpoint with correct payload", async () => {
    await rejectFinding(makeFinding());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("/api/daemon/reject");

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      findingId: "finding-1",
      workspaceId: "ws-alpha",
      target_job_id: "job-a",
    });
  });

  it("throws on error response", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(rejectFinding(makeFinding())).rejects.toThrow("Reject failed: 404");
  });
});

describe("dismissFinding", () => {
  it("calls forget on narrative corpus then clears scratchpad chunk", async () => {
    const callOrder: string[] = [];
    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/narrative/")) callOrder.push("forget");
      if (url.includes("/chunks/")) callOrder.push("clear");
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    await dismissFinding(makeFinding());

    expect(callOrder).toEqual(["forget", "clear"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("targets correct narrative corpus and chunk", async () => {
    await dismissFinding(makeFinding());

    const forgetUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(forgetUrl).toContain("/api/memory/ws-alpha/narrative/notes/finding-1");
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("DELETE");

    const clearUrl = String(fetchSpy.mock.calls[1]?.[0]);
    expect(clearUrl).toContain("/api/scratchpad/improvement%3A%3Aws-alpha/chunks/finding-1");
    expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });
});
