/**
 * Tests for workspace pipeline pure functions.
 *
 * Covers compileFSMs, assembleWorkspaceYml, and executeFSMs.
 * Blueprint generation (LLM-backed) is not tested here — that's covered
 * by @atlas/workspace-builder's own tests.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WorkspaceBlueprintSchema } from "@atlas/workspace-builder";
import { describe, expect, it } from "vitest";
import { assembleWorkspaceYml, compileFSMs, executeFSMs } from "./pipeline.ts";

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

if (!import.meta.dirname) throw new Error("import.meta.dirname unavailable");
const fixturePath = resolve(
  import.meta.dirname,
  "../../../../../../../packages/workspace-builder/fixtures/csv-analysis-plan.json",
);
const csvPlan = WorkspaceBlueprintSchema.parse(JSON.parse(readFileSync(fixturePath, "utf-8")));

// ---------------------------------------------------------------------------
// compileFSMs
// ---------------------------------------------------------------------------

describe("compileFSMs", () => {
  it("compiles all jobs in a blueprint", () => {
    const result = compileFSMs(csvPlan);

    expect(result.fsms).toHaveLength(csvPlan.jobs.length);
    expect(result.warnings).toHaveLength(csvPlan.jobs.length);
  });

  it("each FSM has an id matching its job id", () => {
    const result = compileFSMs(csvPlan);

    for (let i = 0; i < csvPlan.jobs.length; i++) {
      const job = csvPlan.jobs[i];
      const fsm = result.fsms[i];
      if (!job || !fsm) throw new Error("Missing job or FSM");
      expect(fsm.id).toBe(job.id);
    }
  });

  it("each FSM has states and is well-formed", () => {
    const result = compileFSMs(csvPlan);

    for (const fsm of result.fsms) {
      expect(Object.keys(fsm.states).length).toBeGreaterThan(0);
      expect(fsm.states.idle).toBeDefined();
      expect(fsm.states.completed).toBeDefined();
    }
  });

  it("throws on invalid job data", () => {
    const badPlan = {
      ...csvPlan,
      jobs: [
        {
          ...csvPlan.jobs[0]!,
          steps: [
            {
              id: "a",
              agentId: "x",
              executionRef: "x",
              description: "step a",
              depends_on: ["b"],
              executionType: "bundled" as const,
            },
            {
              id: "b",
              agentId: "y",
              executionRef: "y",
              description: "step b",
              depends_on: ["a"],
              executionType: "bundled" as const,
            },
          ],
        },
      ],
    };

    expect(() => compileFSMs(badPlan)).toThrow("FSM compilation failed");
  });
});

// ---------------------------------------------------------------------------
// assembleWorkspaceYml
// ---------------------------------------------------------------------------

describe("assembleWorkspaceYml", () => {
  it("YAML contains workspace name", () => {
    const { fsms } = compileFSMs(csvPlan);
    const result = assembleWorkspaceYml(csvPlan, fsms);

    expect(result.yaml).toContain(csvPlan.workspace.name);
  });

  it("YAML contains agent ids", () => {
    const { fsms } = compileFSMs(csvPlan);
    const result = assembleWorkspaceYml(csvPlan, fsms);

    for (const agent of csvPlan.agents) {
      expect(result.yaml).toContain(agent.id);
    }
  });
});

// ---------------------------------------------------------------------------
// executeFSMs
// ---------------------------------------------------------------------------

describe("executeFSMs", () => {
  it("executes all FSMs in mock mode", async () => {
    const { fsms } = compileFSMs(csvPlan);
    const result = await executeFSMs({ plan: csvPlan, fsms });

    expect(result.reports).toHaveLength(fsms.length);
    for (const report of result.reports) {
      expect(report.success).toBe(true);
      expect(report.finalState).toBe("completed");
    }
  });

  it("skips FSMs with no matching job", async () => {
    const { fsms } = compileFSMs(csvPlan);
    // Mutate FSM id to something that doesn't match any job
    const orphanFsm = { ...fsms[0]!, id: "nonexistent-job" };
    const result = await executeFSMs({ plan: csvPlan, fsms: [orphanFsm] });

    expect(result.reports).toHaveLength(0);
  });
});
