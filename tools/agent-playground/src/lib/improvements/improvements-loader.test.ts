import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadImprovements } from "./improvements-loader.ts";
import type { WorkspaceGroup } from "./types.ts";

const fetchSpy = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

function narrativeEntry(overrides: {
  id?: string;
  kind?: string;
  target_job_id?: string;
  improvement_flag?: string | null;
  before_yaml?: string;
  proposed_full_config?: string;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    kind: overrides.kind ?? "improvement-finding",
    target_job_id: overrides.target_job_id ?? "job-a",
    before_yaml: overrides.before_yaml,
    proposed_full_config: overrides.proposed_full_config,
  };
  if (overrides.improvement_flag !== null) {
    meta.improvement_flag = overrides.improvement_flag ?? "surface";
  }
  return {
    id: overrides.id ?? "f-1",
    text: "Optimise retry config",
    createdAt: "2026-04-14T10:00:00Z",
    metadata: meta,
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadImprovements", () => {
  it("returns only kind=improvement-finding entries with flag=surface", async () => {
    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/narrative/notes")) {
        return Promise.resolve(jsonResponse([
          narrativeEntry({ id: "f-1", improvement_flag: "surface" }),
          narrativeEntry({ id: "f-2", kind: "general-note" }),
          narrativeEntry({ id: "f-3", improvement_flag: "auto" }),
        ]));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const groups = await loadImprovements(["ws-alpha"]);
    const allFindings = groups.flatMap((ws) => ws.jobs.flatMap((j) => j.findings));

    expect(allFindings).toHaveLength(1);
    expect(allFindings[0]?.id).toBe("f-1");
  });

  it("returns WorkspaceGroup[] with nested job arrays", async () => {
    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("ws-a") && url.includes("/narrative/notes")) {
        return Promise.resolve(jsonResponse([
          narrativeEntry({ id: "f-1", target_job_id: "job-1" }),
          narrativeEntry({ id: "f-2", target_job_id: "job-2" }),
          narrativeEntry({ id: "f-3", target_job_id: "job-1" }),
        ]));
      }
      if (url.includes("ws-b") && url.includes("/narrative/notes")) {
        return Promise.resolve(jsonResponse([
          narrativeEntry({ id: "f-4", target_job_id: "job-1" }),
        ]));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const groups: WorkspaceGroup[] = await loadImprovements(["ws-a", "ws-b"]);

    expect(groups).toHaveLength(2);

    const wsA = groups.find((g) => g.workspaceId === "ws-a");
    expect(wsA).toBeDefined();
    expect(wsA?.jobs).toHaveLength(2);

    const wsAJob1 = wsA?.jobs.find((j) => j.targetJobId === "job-1");
    const wsAJob2 = wsA?.jobs.find((j) => j.targetJobId === "job-2");
    expect(wsAJob1?.findings).toHaveLength(2);
    expect(wsAJob2?.findings).toHaveLength(1);

    const wsB = groups.find((g) => g.workspaceId === "ws-b");
    expect(wsB).toBeDefined();
    expect(wsB?.jobs).toHaveLength(1);
    expect(wsB?.jobs[0]?.findings).toHaveLength(1);
  });

  it("returns empty array when no matching entries exist", async () => {
    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/narrative/notes")) {
        return Promise.resolve(jsonResponse([
          narrativeEntry({ kind: "general-note" }),
        ]));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const groups = await loadImprovements(["ws-alpha"]);
    expect(groups).toHaveLength(0);
  });

  it("handles fetch failures gracefully", async () => {
    fetchSpy.mockRejectedValue(new Error("network error"));

    const groups = await loadImprovements(["ws-alpha"]);
    expect(groups).toHaveLength(0);
  });

  it("falls back to KV workspace-level flag when entry has no improvement_flag", async () => {
    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/narrative/notes")) {
        return Promise.resolve(jsonResponse([
          narrativeEntry({ id: "f-1", improvement_flag: null }),
        ]));
      }
      if (url.includes("/kv/config/improvement_flag")) {
        return Promise.resolve(jsonResponse({ value: "surface" }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const groups = await loadImprovements(["ws-alpha"]);
    const allFindings = groups.flatMap((ws) => ws.jobs.flatMap((j) => j.findings));

    expect(allFindings).toHaveLength(1);
    expect(allFindings[0]?.id).toBe("f-1");
  });

  it("excludes entries when KV fallback returns auto", async () => {
    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/narrative/notes")) {
        return Promise.resolve(jsonResponse([
          narrativeEntry({ id: "f-1", improvement_flag: null }),
        ]));
      }
      if (url.includes("/kv/config/improvement_flag")) {
        return Promise.resolve(jsonResponse({ value: "auto" }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const groups = await loadImprovements(["ws-alpha"]);
    expect(groups).toHaveLength(0);
  });

  it("propagates proposed_full_config from metadata to ImprovementEntry", async () => {
    const proposedConfig = "workspace:\n  name: updated\nagents:\n  planner:\n    retries: 5";

    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/narrative/notes")) {
        return Promise.resolve(jsonResponse([
          narrativeEntry({
            id: "f-cfg",
            proposed_full_config: proposedConfig,
            before_yaml: "workspace:\n  name: original",
          }),
        ]));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const groups = await loadImprovements(["ws-alpha"]);
    const allFindings = groups.flatMap((ws) => ws.jobs.flatMap((j) => j.findings));

    expect(allFindings).toHaveLength(1);
    expect(allFindings[0]?.proposedFullConfig).toBe(proposedConfig);
    expect(allFindings[0]?.beforeYaml).toBe("workspace:\n  name: original");
  });
});
