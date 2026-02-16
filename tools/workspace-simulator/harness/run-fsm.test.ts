import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildFSMFromPlan, WorkspaceBlueprintSchema } from "@atlas/workspace-builder";
import { describe, expect, it } from "vitest";
import { runFSM } from "./run-fsm.ts";

// ---------------------------------------------------------------------------
// Fixture: load stable fixture and compile FSM deterministically
// ---------------------------------------------------------------------------

if (!import.meta.dirname) throw new Error("import.meta.dirname unavailable");
const fixturePath = resolve(
  import.meta.dirname,
  "../../../packages/workspace-builder/fixtures/csv-analysis-plan.json",
);
const phase3 = WorkspaceBlueprintSchema.parse(JSON.parse(readFileSync(fixturePath, "utf-8")));
const firstJob = phase3.jobs[0];
if (!firstJob) throw new Error("No jobs in fixture");
const compiled = buildFSMFromPlan(firstJob);
if (!compiled.success) throw new Error("Failed to compile FSM from fixture");
const fsm = compiled.value.fsm;

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

describe("runFSM — csv-analysis-reporter", () => {
  it("reaches completed state with success", async () => {
    const report = await runFSM({ fsm, plan: phase3, triggerSignal: "csv-uploaded" });

    expect(report.success).toBe(true);
    expect(report.finalState).toBe("completed");
  });

  it("captures state transitions ending at completed", async () => {
    const report = await runFSM({ fsm, plan: phase3, triggerSignal: "csv-uploaded" });

    expect(report.stateTransitions.length).toBeGreaterThan(0);
    const last = report.stateTransitions.at(-1);
    if (!last) throw new Error("Expected at least one transition");
    expect(last.to).toBe("completed");
  });

  it("captures expected results in completed snapshot", async () => {
    const report = await runFSM({ fsm, plan: phase3, triggerSignal: "csv-uploaded" });

    const completedResults = report.resultSnapshots.completed;
    expect(completedResults).toBeDefined();
    if (!completedResults) throw new Error("Expected completed results");

    const resultKeys = Object.keys(completedResults);
    expect(resultKeys).toContain("analysis-output");
    expect(resultKeys).toContain("email-confirmation");
  });

  it("action trace has entries", async () => {
    const report = await runFSM({ fsm, plan: phase3, triggerSignal: "csv-uploaded" });

    expect(report.actionTrace.length).toBeGreaterThan(0);
  });

  it("all assertions pass with result_exists prefix", async () => {
    const report = await runFSM({ fsm, plan: phase3, triggerSignal: "csv-uploaded" });

    for (const assertion of report.assertions) {
      expect(assertion.passed, assertion.detail ?? assertion.check).toBe(true);
    }

    // Verify assertion labels use result_exists, not document_exists
    const resultAssertions = report.assertions.filter((a) => a.check.startsWith("result_exists:"));
    expect(resultAssertions.length).toBeGreaterThan(0);
    const documentAssertions = report.assertions.filter((a) =>
      a.check.startsWith("document_exists:"),
    );
    expect(documentAssertions).toHaveLength(0);
  });

  it("reports duration in milliseconds", async () => {
    const report = await runFSM({ fsm, plan: phase3, triggerSignal: "csv-uploaded" });

    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Action trace: input capture
// ---------------------------------------------------------------------------

describe("runFSM — action trace input", () => {
  it("agent action traces include input from inputSnapshot", async () => {
    const report = await runFSM({ fsm, plan: phase3, triggerSignal: "csv-uploaded" });

    expect(report.success).toBe(true);

    // Find completed agent traces (agent actions emit started + completed)
    const completedAgentTraces = report.actionTrace.filter(
      (t) => t.actionType === "agent" && t.status === "completed",
    );
    expect(completedAgentTraces.length).toBeGreaterThan(0);

    // The send-report step has a prepare mapping, so its agent trace should have input
    const emailTrace = completedAgentTraces.find((t) => t.actionId === "email");
    expect(emailTrace).toBeDefined();
    if (!emailTrace) throw new Error("Expected email trace");
    expect(emailTrace.input).toBeDefined();
    expect(emailTrace.input).toHaveProperty("task");
  });

  it("non-agent action traces omit input", async () => {
    const report = await runFSM({ fsm, plan: phase3, triggerSignal: "csv-uploaded" });

    const codeTraces = report.actionTrace.filter((t) => t.actionType === "code");

    for (const trace of codeTraces) {
      expect(trace.input).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Agent overrides
// ---------------------------------------------------------------------------

describe("runFSM — agent overrides", () => {
  it("uses override data when provided", async () => {
    const customData = { summary: "custom analysis", queries: [] };
    const report = await runFSM({
      fsm,
      plan: phase3,
      triggerSignal: "csv-uploaded",
      agentOverrides: { "analysis-output": customData },
    });

    expect(report.success).toBe(true);
    const completedResults = report.resultSnapshots.completed;
    expect(completedResults?.["analysis-output"]).toMatchObject(customData);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("runFSM — error handling", () => {
  it("returns success: false with error when signal not found in FSM", async () => {
    const report = await runFSM({ fsm, plan: phase3, triggerSignal: "nonexistent-signal" });

    // Engine won't transition from idle — still at idle
    expect(report.success).toBe(false);
    expect(report.finalState).toBe("idle");
  });
});
