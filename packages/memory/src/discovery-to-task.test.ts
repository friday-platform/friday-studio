import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { appendDiscoveryAsTask, type Discovery, shortHash, slug } from "./discovery-to-task.ts";

const PostedEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.string(),
  metadata: z.object({
    status: z.string(),
    priority: z.number(),
    kind: z.string(),
    blocked_by: z.array(z.string()),
    match_job_name: z.string(),
    auto_apply: z.boolean(),
    discovered_by: z.string(),
    discovered_session: z.string(),
    payload: z.object({
      workspace_id: z.string(),
      signal_id: z.string(),
      task_id: z.string(),
      task_brief: z.string(),
      target_files: z.array(z.string()),
    }),
  }),
});

function parsePostedBody(opts: RequestInit): z.infer<typeof PostedEntrySchema> {
  const raw: unknown = JSON.parse(opts.body as string);
  return PostedEntrySchema.parse(raw);
}

describe("slug", () => {
  it("lowercases and replaces spaces/special chars with hyphens", () => {
    expect(slug("Hello World")).toBe("hello-world");
    expect(slug("Fix: broken config!")).toBe("fix-broken-config");
    expect(slug("  --leading-trailing--  ")).toBe("leading-trailing");
    expect(slug("UPPER CASE 123")).toBe("upper-case-123");
  });

  it("handles empty string", () => {
    expect(slug("")).toBe("");
  });
});

describe("shortHash", () => {
  it("returns an 8-char hex string", async () => {
    const hash = await shortHash("test input");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic for same input", async () => {
    const a = await shortHash("same-title+same-session");
    const b = await shortHash("same-title+same-session");
    expect(a).toBe(b);
  });

  it("differs for different inputs", async () => {
    const a = await shortHash("input-a");
    const b = await shortHash("input-b");
    expect(a).not.toBe(b);
  });
});

describe("appendDiscoveryAsTask", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  const baseDiscovery: Discovery = {
    discovered_by: "review-target-workspace",
    discovered_session: "session-abc",
    target_workspace_id: "braised_biscuit",
    target_signal_id: "run-task",
    title: "Fix workspace drift",
    brief: "The workspace config is out of sync with the agents running.",
    target_files: ["workspace.yml"],
    priority: 50,
    kind: "reviewer",
    auto_apply: false,
  };

  it("POSTs a NarrativeEntry with correct shape", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "auto-reviewer-fix-workspace-drift-abcd1234",
          createdAt: "2026-04-14T00:00:00.000Z",
        }),
    });

    const result = await appendDiscoveryAsTask(
      "http://localhost:8080/api/memory/thick_endive/narrative/autopilot-backlog",
      baseDiscovery,
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8080/api/memory/thick_endive/narrative/autopilot-backlog");
    expect(opts.method).toBe("POST");

    const body = parsePostedBody(opts);
    expect(body.id).toMatch(/^auto-reviewer-fix-workspace-drift-[0-9a-f]{8}$/);
    expect(body.text).toBe("Fix workspace drift");
    expect(body.metadata.status).toBe("pending");
    expect(body.metadata.auto_apply).toBe(false);
    expect(body.metadata.discovered_by).toBe("review-target-workspace");
    expect(body.metadata.discovered_session).toBe("session-abc");
    expect(body.metadata.priority).toBe(50);
    expect(body.metadata.kind).toBe("reviewer");
    expect(body.metadata.blocked_by).toEqual([]);
    expect(body.metadata.match_job_name).toBe("execute-task");
    expect(body.metadata.payload.workspace_id).toBe("braised_biscuit");
    expect(body.metadata.payload.signal_id).toBe("run-task");
    expect(body.metadata.payload.task_id).toBe(body.id);
    expect(body.metadata.payload.task_brief).toBe(baseDiscovery.brief);
    expect(body.metadata.payload.target_files).toEqual(["workspace.yml"]);

    expect(result.id).toMatch(/^auto-reviewer-/);
    expect(result.createdAt).toBe("2026-04-14T00:00:00.000Z");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await expect(
      appendDiscoveryAsTask("http://localhost:8080/test", baseDiscovery),
    ).rejects.toThrow("HTTP 500");
  });

  it("generates deterministic id for same title+session", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "x", createdAt: "2026-01-01T00:00:00Z" }),
    });

    await appendDiscoveryAsTask("http://localhost:8080/test", baseDiscovery);
    await appendDiscoveryAsTask("http://localhost:8080/test", baseDiscovery);

    const body1 = parsePostedBody((mockFetch.mock.calls[0] as [string, RequestInit])[1]);
    const body2 = parsePostedBody((mockFetch.mock.calls[1] as [string, RequestInit])[1]);
    expect(body1.id).toBe(body2.id);
  });
});
