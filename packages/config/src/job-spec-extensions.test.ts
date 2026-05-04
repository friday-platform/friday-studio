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
  it("rejects a `concurrency` field — jobs are always isolated", () => {
    const result = JobSpecificationSchema.safeParse({
      ...minimalFsmJob,
      concurrency: { policy: "serialize" },
    });
    expect(result.success).toBe(false);
  });
});
