import { describe, expect, it } from "vitest";
import { JobSpecificationSchema } from "./jobs.ts";
import { WorkspaceConfigSchema } from "./workspace.ts";

const minimalFsmJob = { fsm: { id: "t", initial: "idle", states: {} } };

const minimalWorkspace = {
  version: "1.0" as const,
  workspace: { name: "test", description: "test workspace" },
};

describe("JobSpecificationSchema extension fields", () => {
  it("accepts outputs: {memory, entryKind} on an FSM-based job", () => {
    const result = JobSpecificationSchema.safeParse({
      ...minimalFsmJob,
      outputs: { memory: "notes", entryKind: "finding" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.outputs).toEqual({ memory: "notes", entryKind: "finding" });
    }
  });

  it("accepts improvement_key_convention: {scoped, default} on an FSM-based job", () => {
    const result = JobSpecificationSchema.safeParse({
      ...minimalFsmJob,
      improvement_key_convention: {
        scoped: "jobs.{id}.improvement",
        default: "workspace.improvement",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.improvement_key_convention).toEqual({
        scoped: "jobs.{id}.improvement",
        default: "workspace.improvement",
      });
    }
  });

  it("accepts scope_exclusions: string[] on an FSM-based job", () => {
    const result = JobSpecificationSchema.safeParse({
      ...minimalFsmJob,
      scope_exclusions: ["skills", "source"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope_exclusions).toEqual(["skills", "source"]);
    }
  });

  it("accepts all three extension fields together in one FSM job spec", () => {
    const result = JobSpecificationSchema.safeParse({
      ...minimalFsmJob,
      outputs: { memory: "notes", entryKind: "finding" },
      improvement_key_convention: {
        scoped: "jobs.{target_job_id}.improvement",
        default: "workspace.improvement",
      },
      scope_exclusions: ["skills", "source"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.outputs).toEqual({ memory: "notes", entryKind: "finding" });
      expect(result.data.improvement_key_convention).toEqual({
        scoped: "jobs.{target_job_id}.improvement",
        default: "workspace.improvement",
      });
      expect(result.data.scope_exclusions).toEqual(["skills", "source"]);
    }
  });
});

describe("WorkspaceConfigSchema round-trip with job extension fields", () => {
  it("parses a job entry containing outputs, improvement_key_convention, scope_exclusions", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      jobs: {
        "review-target-workspace": {
          fsm: { id: "review", initial: "idle", states: {} },
          outputs: { memory: "notes", entryKind: "finding" },
          improvement_key_convention: {
            scoped: "jobs.{target_job_id}.improvement",
            default: "workspace.improvement",
          },
          scope_exclusions: ["skills", "source"],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("still rejects top-level corpus_mounts (legacy field must remain rejected)", () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...minimalWorkspace,
      corpus_mounts: [{ workspace: "ws", corpus: "c", kind: "narrative", mode: "read" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("JobSpecificationSchema concurrency", () => {
  it("accepts each named policy", () => {
    for (const policy of [
      "concurrent",
      "serialize",
      "skip-if-running",
      "coalesce",
      "singleton",
    ] as const) {
      const result = JobSpecificationSchema.safeParse({
        ...minimalFsmJob,
        concurrency: { policy },
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.concurrency?.policy).toBe(policy);
    }
  });

  it("defaults policy to 'concurrent' when omitted on the inner object", () => {
    const result = JobSpecificationSchema.safeParse({ ...minimalFsmJob, concurrency: {} });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.concurrency?.policy).toBe("concurrent");
  });

  it("rejects unknown policy", () => {
    const result = JobSpecificationSchema.safeParse({
      ...minimalFsmJob,
      concurrency: { policy: "best-effort" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts max_queued for serialize", () => {
    const result = JobSpecificationSchema.safeParse({
      ...minimalFsmJob,
      concurrency: { policy: "serialize", max_queued: 10 },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.concurrency?.max_queued).toBe(10);
  });

  it("rejects negative max_queued", () => {
    const result = JobSpecificationSchema.safeParse({
      ...minimalFsmJob,
      concurrency: { policy: "serialize", max_queued: -1 },
    });
    expect(result.success).toBe(false);
  });

  it("omitting the field is fine — runtime applies the default", () => {
    const result = JobSpecificationSchema.safeParse(minimalFsmJob);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.concurrency).toBeUndefined();
  });
});
