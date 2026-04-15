import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkIntegrity } from "./integrity.ts";
import type { DecomposerResult, ProposedTask } from "./schemas.ts";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "integrity-test-"));
  writeFileSync(join(tempDir, "existing-file.ts"), "");
});

afterAll(() => {
  rmSync(tempDir, { recursive: true });
});

const VALID_BRIEF = [
  "## Context",
  "Some context here.",
  "",
  "## Acceptance Criteria",
  "- [ ] It works correctly",
  "",
  "## Starting Points",
  "- src/main.ts",
].join("\n");

function makeTask(overrides: Partial<ProposedTask> = {}): ProposedTask {
  return {
    task_id: "task-a",
    subject: "Implement the feature",
    task_brief: VALID_BRIEF,
    target_files: ["existing-file.ts"],
    blocked_by: [],
    priority: 10,
    is_tracer: false,
    ...overrides,
  };
}

function makeBatch(tasks: ProposedTask[]): DecomposerResult {
  return {
    batch_id: "dp-test-20260415-abc12345",
    plan_ref: { path: "docs/plans/test.md", sha: "abc1234567890" },
    default_target: { workspace_id: "test-ws", signal_id: "run-task" },
    tasks,
  };
}

describe("checkIntegrity", () => {
  describe("no_cycles", () => {
    it("passes with linear dependency chain", () => {
      const batch = makeBatch([
        makeTask({
          task_id: "tracer",
          is_tracer: true,
          subject: "Tracer Bullet: Foundation",
          blocked_by: [],
        }),
        makeTask({ task_id: "task-b", blocked_by: ["tracer"] }),
        makeTask({ task_id: "task-c", blocked_by: ["task-b"] }),
      ]);
      const findings = checkIntegrity(batch, tempDir);
      expect(findings).toEqual([]);
    });

    it("detects a cycle in blocked_by graph", () => {
      const batch = makeBatch([
        makeTask({
          task_id: "tracer",
          is_tracer: true,
          subject: "Tracer Bullet: Setup",
          blocked_by: [],
        }),
        makeTask({ task_id: "task-a", blocked_by: ["task-b"] }),
        makeTask({ task_id: "task-b", blocked_by: ["task-a"] }),
      ]);
      const findings = checkIntegrity(batch, tempDir);
      const cycleFindings = findings.filter((f) => f.rule === "no_cycles");
      expect(cycleFindings).toHaveLength(1);
      expect(cycleFindings[0]?.detail).toContain("task-a");
      expect(cycleFindings[0]?.detail).toContain("task-b");
    });
  });

  describe("blocked_by_resolves", () => {
    it("passes when all blocked_by entries exist in batch", () => {
      const batch = makeBatch([makeTask({ task_id: "task-a", blocked_by: [] })]);
      const findings = checkIntegrity(batch, tempDir);
      expect(findings).toEqual([]);
    });

    it("detects dangling blocked_by reference", () => {
      const batch = makeBatch([makeTask({ task_id: "task-a", blocked_by: ["phantom-task"] })]);
      const findings = checkIntegrity(batch, tempDir);
      const refFindings = findings.filter((f) => f.rule === "blocked_by_resolves");
      expect(refFindings).toHaveLength(1);
      expect(refFindings[0]?.task_id).toBe("task-a");
      expect(refFindings[0]?.detail).toContain("phantom-task");
    });
  });

  describe("non_empty_content", () => {
    it("passes with well-formed content", () => {
      const batch = makeBatch([makeTask()]);
      const findings = checkIntegrity(batch, tempDir);
      expect(findings).toEqual([]);
    });

    it("fails on empty subject", () => {
      const batch = makeBatch([makeTask({ subject: "" })]);
      const findings = checkIntegrity(batch, tempDir);
      const contentFindings = findings.filter((f) => f.rule === "non_empty_content");
      expect(contentFindings).toHaveLength(1);
      expect(contentFindings[0]?.detail).toContain("empty subject");
    });

    it("fails when Acceptance Criteria section is missing", () => {
      const batch = makeBatch([
        makeTask({ task_brief: "## Context\nSome content\n\n## Starting Points\n- file.ts" }),
      ]);
      const findings = checkIntegrity(batch, tempDir);
      const contentFindings = findings.filter((f) => f.rule === "non_empty_content");
      expect(contentFindings).toHaveLength(1);
      expect(contentFindings[0]?.detail).toContain("Acceptance Criteria");
    });

    it("fails when Starting Points section has no content", () => {
      const batch = makeBatch([
        makeTask({
          task_brief:
            "## Context\nContent\n\n## Acceptance Criteria\n- It works\n\n## Starting Points\n",
        }),
      ]);
      const findings = checkIntegrity(batch, tempDir);
      const contentFindings = findings.filter((f) => f.rule === "non_empty_content");
      expect(contentFindings).toHaveLength(1);
      expect(contentFindings[0]?.detail).toContain("Starting Points");
    });
  });

  describe("tracer_discipline", () => {
    it("passes with valid tracer in multi-task batch", () => {
      const batch = makeBatch([
        makeTask({
          task_id: "tracer",
          is_tracer: true,
          subject: "Tracer Bullet: Setup infrastructure",
          blocked_by: [],
        }),
        makeTask({ task_id: "task-b" }),
      ]);
      const findings = checkIntegrity(batch, tempDir);
      expect(findings).toEqual([]);
    });

    it("fails when multi-task batch has zero tracers", () => {
      const batch = makeBatch([makeTask({ task_id: "task-a" }), makeTask({ task_id: "task-b" })]);
      const findings = checkIntegrity(batch, tempDir);
      const tracerFindings = findings.filter((f) => f.rule === "tracer_discipline");
      expect(tracerFindings).toHaveLength(1);
      expect(tracerFindings[0]?.detail).toContain("no tracer");
    });

    it("fails when multi-task batch has two tracers", () => {
      const batch = makeBatch([
        makeTask({
          task_id: "task-a",
          is_tracer: true,
          subject: "Tracer Bullet: A",
          blocked_by: [],
        }),
        makeTask({
          task_id: "task-b",
          is_tracer: true,
          subject: "Tracer Bullet: B",
          blocked_by: [],
        }),
      ]);
      const findings = checkIntegrity(batch, tempDir);
      const tracerFindings = findings.filter((f) => f.rule === "tracer_discipline");
      expect(tracerFindings).toHaveLength(1);
      expect(tracerFindings[0]?.detail).toContain("2 tracer tasks");
    });

    it("fails when tracer has non-empty blocked_by", () => {
      const batch = makeBatch([
        makeTask({
          task_id: "tracer",
          is_tracer: true,
          subject: "Tracer Bullet: Setup",
          blocked_by: ["task-b"],
        }),
        makeTask({ task_id: "task-b" }),
      ]);
      const findings = checkIntegrity(batch, tempDir);
      const tracerFindings = findings.filter((f) => f.rule === "tracer_discipline");
      expect(tracerFindings).toHaveLength(1);
      expect(tracerFindings[0]?.detail).toContain("blocked_by");
    });

    it("fails when tracer subject missing Tracer Bullet: prefix", () => {
      const batch = makeBatch([
        makeTask({
          task_id: "tracer",
          is_tracer: true,
          subject: "Setup infrastructure",
          blocked_by: [],
        }),
        makeTask({ task_id: "task-b" }),
      ]);
      const findings = checkIntegrity(batch, tempDir);
      const tracerFindings = findings.filter((f) => f.rule === "tracer_discipline");
      expect(tracerFindings).toHaveLength(1);
      expect(tracerFindings[0]?.detail).toContain("Tracer Bullet:");
    });

    it("skips rule entirely for single-task batch", () => {
      const batch = makeBatch([makeTask({ is_tracer: true, subject: "Not a tracer prefix" })]);
      const findings = checkIntegrity(batch, tempDir);
      const tracerFindings = findings.filter((f) => f.rule === "tracer_discipline");
      expect(tracerFindings).toHaveLength(0);
    });
  });

  describe("target_files_resolve", () => {
    it("passes when files exist on disk", () => {
      const batch = makeBatch([makeTask({ target_files: ["existing-file.ts"] })]);
      const findings = checkIntegrity(batch, tempDir);
      expect(findings).toEqual([]);
    });

    it("passes when file is marked (to-create) in sibling task", () => {
      const batch = makeBatch([
        makeTask({
          task_id: "tracer",
          is_tracer: true,
          subject: "Tracer Bullet: Create module",
          blocked_by: [],
          target_files: ["new-module.ts"],
          task_brief:
            "## Context\nCreate new-module.ts (to-create)\n\n## Acceptance Criteria\n- Module created\n\n## Starting Points\n- Start here",
        }),
        makeTask({
          task_id: "consumer",
          target_files: ["new-module.ts", "existing-file.ts"],
          task_brief:
            "## Context\nUse new-module.ts (to-create)\n\n## Acceptance Criteria\n- Module consumed\n\n## Starting Points\n- Start here",
        }),
      ]);
      const findings = checkIntegrity(batch, tempDir);
      const resolveFindings = findings.filter((f) => f.rule === "target_files_resolve");
      expect(resolveFindings).toEqual([]);
    });

    it("fails when file does not exist and is not (to-create)", () => {
      const batch = makeBatch([makeTask({ target_files: ["nonexistent/path.ts"] })]);
      const findings = checkIntegrity(batch, tempDir);
      const resolveFindings = findings.filter((f) => f.rule === "target_files_resolve");
      expect(resolveFindings).toHaveLength(1);
      expect(resolveFindings[0]?.task_id).toBe("task-a");
      expect(resolveFindings[0]?.detail).toContain("nonexistent/path.ts");
    });
  });

  describe("integration", () => {
    it("valid batch passes all 5 rules simultaneously", () => {
      const batch = makeBatch([
        makeTask({
          task_id: "tracer",
          is_tracer: true,
          subject: "Tracer Bullet: Foundation",
          blocked_by: [],
        }),
        makeTask({ task_id: "task-b", blocked_by: ["tracer"] }),
        makeTask({ task_id: "task-c", blocked_by: ["task-b"] }),
      ]);
      const findings = checkIntegrity(batch, tempDir);
      expect(findings).toEqual([]);
    });
  });
});
