import { describe, expect, it } from "vitest";
import { JobSpecificationSchema } from "./jobs.ts";
import { DelegationBudgetSchema, WorkspaceConfigSchema } from "./workspace.ts";

describe("DelegationBudgetSchema", () => {
  it("accepts an empty object", () => {
    expect(DelegationBudgetSchema.parse({})).toEqual({});
  });

  it("accepts the full set of budget fields", () => {
    const parsed = DelegationBudgetSchema.parse({
      max_depth: 2,
      max_steps_per_call: 40,
      max_output_tokens: 20000,
      max_input_tokens: 100000,
      max_wall_time_ms: 120000,
      max_cost_usd: null,
    });
    expect(parsed.max_depth).toBe(2);
    expect(parsed.max_cost_usd).toBe(null);
  });

  it("rejects zero or negative budgets", () => {
    expect(() => DelegationBudgetSchema.parse({ max_depth: 0 })).toThrow();
    expect(() => DelegationBudgetSchema.parse({ max_steps_per_call: -1 })).toThrow();
    expect(() => DelegationBudgetSchema.parse({ max_wall_time_ms: 0 })).toThrow();
  });

  it("rejects non-integer step / depth budgets", () => {
    expect(() => DelegationBudgetSchema.parse({ max_depth: 1.5 })).toThrow();
    expect(() => DelegationBudgetSchema.parse({ max_steps_per_call: 2.7 })).toThrow();
  });

  it("accepts max_cost_usd: number, max_cost_usd: null, or omitted", () => {
    expect(DelegationBudgetSchema.parse({ max_cost_usd: 0.5 }).max_cost_usd).toBe(0.5);
    expect(DelegationBudgetSchema.parse({ max_cost_usd: null }).max_cost_usd).toBe(null);
    expect(DelegationBudgetSchema.parse({}).max_cost_usd).toBeUndefined();
  });

  it("rejects unknown fields (strict object)", () => {
    expect(() => DelegationBudgetSchema.parse({ unknownField: 1 })).toThrow();
  });
});

describe("JobSpecificationSchema delegation override", () => {
  // Phase 8 — per-job `delegation:` override on JobSpecification, mirrors
  // the per-job `permissions:` pattern from `44f5605`. Schema accepts the
  // same fields as the workspace-level block; merge precedence (job wins
  // per-field) is enforced at the runtime layer, not in Zod.
  const minimalJob = { fsm: { id: "x", initial: "s", states: { s: { type: "final" } } } };

  it("accepts a job without delegation (back-compat)", () => {
    const parsed = JobSpecificationSchema.parse(minimalJob);
    expect(parsed.delegation).toBeUndefined();
  });

  it("accepts a job with a delegation override", () => {
    const parsed = JobSpecificationSchema.parse({
      ...minimalJob,
      delegation: { max_depth: 3, max_wall_time_ms: 5000 },
    });
    expect(parsed.delegation?.max_depth).toBe(3);
    expect(parsed.delegation?.max_wall_time_ms).toBe(5000);
  });

  it("rejects unknown fields inside the per-job delegation block", () => {
    expect(() =>
      JobSpecificationSchema.parse({ ...minimalJob, delegation: { unknownField: 1 } }),
    ).toThrow();
  });

  it("rejects zero or negative budgets at the per-job level", () => {
    expect(() =>
      JobSpecificationSchema.parse({ ...minimalJob, delegation: { max_depth: 0 } }),
    ).toThrow();
  });
});

describe("WorkspaceConfigSchema with delegation block", () => {
  const minimalWorkspace = {
    version: "1.0" as const,
    workspace: { name: "test", id: "test", description: "test workspace" },
  };

  it("accepts a workspace without delegation (back-compat)", () => {
    const parsed = WorkspaceConfigSchema.parse(minimalWorkspace);
    expect(parsed.delegation).toBeUndefined();
  });

  it("accepts a workspace with delegation budgets set", () => {
    const parsed = WorkspaceConfigSchema.parse({
      ...minimalWorkspace,
      delegation: { max_depth: 2, max_wall_time_ms: 60_000 },
    });
    expect(parsed.delegation?.max_depth).toBe(2);
    expect(parsed.delegation?.max_wall_time_ms).toBe(60_000);
  });
});
