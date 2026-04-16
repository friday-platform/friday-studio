import { describe, expect, it } from "vitest";
import type {
  DecomposePlanSignal,
  DecomposerResult,
  IntegrityFinding,
  ProposedTask,
} from "./schemas.ts";
import {
  DecomposePlanSignalSchema,
  DecomposerResultSchema,
  IntegrityFindingSchema,
  ProposedTaskSchema,
} from "./schemas.ts";

const VALID_TASK = {
  task_id: "extract-schemas",
  subject: "Extract Zod schemas to shared module",
  task_brief: "## Context\nMove inline schemas to schemas.ts",
  target_files: ["workspaces/system/jobs/decompose-plan/schemas.ts"],
  blocked_by: [],
  priority: 10,
  is_tracer: true,
  target_workspace_id: "braised_biscuit",
  target_signal_id: "run-task",
  plan_section: "Phase 1 § Data contracts",
};

const VALID_RESULT = {
  batch_id: "dp-decompose-plan-design-20260415-abc12345",
  plan_ref: { path: "docs/plans/2026-04-15-decompose-plan-design.md", sha: "abc1234567890" },
  default_target: { workspace_id: "braised_biscuit", signal_id: "run-task" },
  tasks: [VALID_TASK],
};

describe("ProposedTaskSchema", () => {
  it("accepts a valid task", () => {
    const parsed = ProposedTaskSchema.parse(VALID_TASK);
    expect(parsed.task_id).toBe("extract-schemas");
    expect(parsed.is_tracer).toBe(true);
  });

  it("rejects task_id with uppercase", () => {
    expect(() => ProposedTaskSchema.parse({ ...VALID_TASK, task_id: "Extract-Schemas" })).toThrow();
  });

  it("rejects task_id with spaces", () => {
    expect(() => ProposedTaskSchema.parse({ ...VALID_TASK, task_id: "extract schemas" })).toThrow();
  });

  it("strips unknown keys", () => {
    const parsed = ProposedTaskSchema.parse({ ...VALID_TASK, extra_field: true });
    expect("extra_field" in parsed).toBe(false);
  });
});

describe("DecomposerResultSchema", () => {
  it("accepts a valid result", () => {
    const parsed = DecomposerResultSchema.parse(VALID_RESULT);
    expect(parsed.batch_id).toBe("dp-decompose-plan-design-20260415-abc12345");
    expect(parsed.tasks).toHaveLength(1);
  });

  it("rejects empty tasks array", () => {
    expect(() => DecomposerResultSchema.parse({ ...VALID_RESULT, tasks: [] })).toThrow();
  });

  it("accepts plan_ref with optional scope", () => {
    const withScope = { ...VALID_RESULT, plan_ref: { ...VALID_RESULT.plan_ref, scope: "Phase 1" } };
    const parsed = DecomposerResultSchema.parse(withScope);
    expect(parsed.plan_ref.scope).toBe("Phase 1");
  });
});

describe("DecomposePlanSignalSchema", () => {
  it("accepts minimal payload", () => {
    const minimal = {
      plan_path: "docs/plans/my-plan.md",
      default_target: { workspace_id: "braised_biscuit", signal_id: "run-task" },
    };
    const parsed = DecomposePlanSignalSchema.parse(minimal);
    expect(parsed.plan_path).toBe("docs/plans/my-plan.md");
    expect(parsed.scope).toBeUndefined();
    expect(parsed.dry_run).toBeUndefined();
  });

  it("accepts full payload with optional fields", () => {
    const full = {
      plan_path: "docs/plans/my-plan.md",
      scope: "Phase 2",
      default_target: { workspace_id: "braised_biscuit", signal_id: "run-task" },
      dry_run: true,
    };
    const parsed = DecomposePlanSignalSchema.parse(full);
    expect(parsed.dry_run).toBe(true);
  });
});

describe("IntegrityFindingSchema", () => {
  it("accepts a valid finding", () => {
    const finding = {
      rule: "no_cycles" as const,
      severity: "BLOCK" as const,
      task_id: "extract-schemas",
      detail: "Cycle detected: a → b → a",
    };
    const parsed = IntegrityFindingSchema.parse(finding);
    expect(parsed.rule).toBe("no_cycles");
  });

  it("rejects unknown rule values", () => {
    expect(() =>
      IntegrityFindingSchema.parse({ rule: "unknown_rule", severity: "BLOCK", detail: "bad" }),
    ).toThrow();
  });

  it("accepts finding without task_id", () => {
    const finding = {
      rule: "non_empty_content" as const,
      severity: "BLOCK" as const,
      detail: "All tasks must have non-empty task_brief",
    };
    const parsed = IntegrityFindingSchema.parse(finding);
    expect(parsed.task_id).toBeUndefined();
  });
});

describe("type-level assignability", () => {
  it("inferred types are assignable from parsed output", () => {
    const signal: DecomposePlanSignal = DecomposePlanSignalSchema.parse({
      plan_path: "p.md",
      default_target: { workspace_id: "w", signal_id: "s" },
    });
    const task: ProposedTask = ProposedTaskSchema.parse(VALID_TASK);
    const result: DecomposerResult = DecomposerResultSchema.parse(VALID_RESULT);
    const finding: IntegrityFinding = IntegrityFindingSchema.parse({
      rule: "no_cycles",
      severity: "BLOCK",
      detail: "ok",
    });

    expect(signal).toBeDefined();
    expect(task).toBeDefined();
    expect(result).toBeDefined();
    expect(finding).toBeDefined();
  });
});
