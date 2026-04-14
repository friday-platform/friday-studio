import { describe, expect, it } from "vitest";
import type { NarrativeEntry } from "@atlas/agent-sdk";
import { asImprovementFinding, groupFindings } from "./improvement-finding.ts";

function makeFinding(overrides: {
  id?: string;
  workspaceId?: string;
  target_job_id?: string;
}): NarrativeEntry {
  return {
    id: overrides.id ?? "f-1",
    text: "Optimise retry config",
    createdAt: "2026-04-14T10:00:00Z",
    metadata: {
      kind: "improvement-finding",
      workspaceId: overrides.workspaceId ?? "ws-alpha",
      target_job_id: overrides.target_job_id ?? "job-a",
      proposed_diff: "--- a\n+++ b\n-old\n+new",
      proposed_full_config: "agents:\n  planner:\n    retries: 3",
      improvement_mode: "surface",
    },
  };
}

describe("asImprovementFinding", () => {
  it("returns parsed finding for valid improvement entry", () => {
    const entry = makeFinding({});
    const result = asImprovementFinding(entry);
    expect(result).not.toBeNull();
    expect(result?.metadata.kind).toBe("improvement-finding");
    expect(result?.metadata.workspaceId).toBe("ws-alpha");
  });

  it("returns null when metadata.kind is not improvement-finding", () => {
    const entry: NarrativeEntry = {
      id: "f-2",
      text: "some note",
      createdAt: "2026-04-14T10:00:00Z",
      metadata: { kind: "general-note" },
    };
    expect(asImprovementFinding(entry)).toBeNull();
  });

  it("returns null when metadata is undefined", () => {
    const entry: NarrativeEntry = {
      id: "f-3",
      text: "bare entry",
      createdAt: "2026-04-14T10:00:00Z",
    };
    expect(asImprovementFinding(entry)).toBeNull();
  });

  it("returns null when required metadata fields are missing", () => {
    const entry: NarrativeEntry = {
      id: "f-4",
      text: "partial metadata",
      createdAt: "2026-04-14T10:00:00Z",
      metadata: {
        kind: "improvement-finding",
        workspaceId: "ws-1",
      },
    };
    expect(asImprovementFinding(entry)).toBeNull();
  });
});

describe("groupFindings", () => {
  it("groups entries by workspaceId then target_job_id", () => {
    const entries: NarrativeEntry[] = [
      makeFinding({ id: "f-1", workspaceId: "ws-a", target_job_id: "job-1" }),
      makeFinding({ id: "f-2", workspaceId: "ws-a", target_job_id: "job-2" }),
      makeFinding({ id: "f-3", workspaceId: "ws-a", target_job_id: "job-1" }),
      makeFinding({ id: "f-4", workspaceId: "ws-b", target_job_id: "job-1" }),
    ];

    const result = groupFindings(entries);

    expect(result.size).toBe(2);

    const wsA = result.get("ws-a");
    expect(wsA).toBeDefined();
    expect(wsA?.size).toBe(2);
    expect(wsA?.get("job-1")?.length).toBe(2);
    expect(wsA?.get("job-2")?.length).toBe(1);

    const wsB = result.get("ws-b");
    expect(wsB).toBeDefined();
    expect(wsB?.size).toBe(1);
    expect(wsB?.get("job-1")?.length).toBe(1);
  });

  it("returns empty map when no entries match", () => {
    const entries: NarrativeEntry[] = [
      { id: "x-1", text: "not a finding", createdAt: "2026-04-14T10:00:00Z" },
      { id: "x-2", text: "also not", createdAt: "2026-04-14T10:00:00Z", metadata: { kind: "note" } },
    ];

    const result = groupFindings(entries);
    expect(result.size).toBe(0);
  });

  it("returns empty map for empty input", () => {
    expect(groupFindings([]).size).toBe(0);
  });

  it("filters out non-matching entries mixed with valid ones", () => {
    const entries: NarrativeEntry[] = [
      makeFinding({ id: "valid-1", workspaceId: "ws-a", target_job_id: "job-1" }),
      { id: "invalid", text: "note", createdAt: "2026-04-14T10:00:00Z" },
      makeFinding({ id: "valid-2", workspaceId: "ws-a", target_job_id: "job-1" }),
    ];

    const result = groupFindings(entries);
    expect(result.size).toBe(1);
    expect(result.get("ws-a")?.get("job-1")?.length).toBe(2);
  });
});
