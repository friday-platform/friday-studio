import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClassifiedJobWithDAG } from "../planner/stamp-execution-types.ts";
import { WorkspaceBlueprintSchema } from "../types.ts";
import { buildFSMFromPlan, formatCompilerWarnings } from "./build-fsm.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Load a fixture JSON and parse through WorkspaceBlueprintSchema.
 * Fixtures represent post-classification data with executionType set.
 */
function loadFixturePlan(name: string) {
  const dirname = import.meta.dirname;
  if (!dirname) throw new Error("import.meta.dirname is undefined");
  const fixturePath = resolve(dirname, "../fixtures", `${name}.json`);
  return WorkspaceBlueprintSchema.parse(JSON.parse(readFileSync(fixturePath, "utf-8")));
}

function loadFixtureJob(name: string): ClassifiedJobWithDAG {
  const plan = loadFixturePlan(name);
  const job = plan.jobs[0];
  if (!job) throw new Error(`Fixture "${name}" has no jobs`);
  return job;
}

function loadFixtureJobs(name: string): [ClassifiedJobWithDAG, ClassifiedJobWithDAG] {
  const plan = loadFixturePlan(name);
  const [a, b] = plan.jobs;
  if (!a || !b) throw new Error(`Fixture "${name}" needs at least 2 jobs`);
  return [a, b];
}

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — validation", () => {
  it("rejects jobs with cycles (mutual dependency)", () => {
    const job: ClassifiedJobWithDAG = {
      id: "cyclic",
      name: "Cyclic",
      title: "Cycle",
      triggerSignalId: "test",
      steps: [
        {
          id: "a",
          agentId: "x",
          description: "A",
          depends_on: ["b"],
          executionType: "bundled",
          executionRef: "x",
        },
        {
          id: "b",
          agentId: "x",
          description: "B",
          depends_on: ["a"],
          executionType: "bundled",
          executionRef: "x",
        },
      ],
      documentContracts: [],
      prepareMappings: [],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(!result.success);
    expect(result.error).toContainEqual(expect.objectContaining({ type: "no_root_steps" }));
  });

  it("rejects jobs with cycles (root + cycle)", () => {
    const job: ClassifiedJobWithDAG = {
      id: "cyclic-with-root",
      name: "Cyclic",
      title: "Cycle",
      triggerSignalId: "test",
      steps: [
        {
          id: "root",
          agentId: "x",
          description: "Root",
          depends_on: [],
          executionType: "bundled",
          executionRef: "x",
        },
        {
          id: "a",
          agentId: "x",
          description: "A",
          depends_on: ["root", "b"],
          executionType: "bundled",
          executionRef: "x",
        },
        {
          id: "b",
          agentId: "x",
          description: "B",
          depends_on: ["a"],
          executionType: "bundled",
          executionRef: "x",
        },
      ],
      documentContracts: [],
      prepareMappings: [],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(!result.success);
    expect(result.error).toContainEqual(expect.objectContaining({ type: "cycle_detected" }));
  });

  it("rejects jobs with missing dependencies", () => {
    const job: ClassifiedJobWithDAG = {
      id: "missing-dep",
      name: "Missing",
      title: "Missing",
      triggerSignalId: "test",
      steps: [
        {
          id: "a",
          agentId: "x",
          description: "A",
          depends_on: [],
          executionType: "bundled",
          executionRef: "x",
        },
        {
          id: "b",
          agentId: "x",
          description: "B",
          depends_on: ["nonexistent"],
          executionType: "bundled",
          executionRef: "x",
        },
      ],
      documentContracts: [],
      prepareMappings: [],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(!result.success);
    expect(result.error).toContainEqual(expect.objectContaining({ type: "missing_dependency" }));
  });

  it("rejects jobs with duplicate step IDs", () => {
    const job: ClassifiedJobWithDAG = {
      id: "dupe",
      name: "Dupe",
      title: "Dupe",
      triggerSignalId: "test",
      steps: [
        {
          id: "a",
          agentId: "x",
          description: "A1",
          depends_on: [],
          executionType: "bundled",
          executionRef: "x",
        },
        {
          id: "a",
          agentId: "y",
          description: "A2",
          depends_on: [],
          executionType: "bundled",
          executionRef: "y",
        },
      ],
      documentContracts: [],
      prepareMappings: [],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(!result.success);
    expect(result.error).toContainEqual(expect.objectContaining({ type: "duplicate_step_id" }));
  });
});

// ---------------------------------------------------------------------------
// Linear pipeline (CSV analysis: analyze-csv → send-report)
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — csv-analysis (linear)", () => {
  it("compiles a 2-step linear pipeline", () => {
    const job = loadFixtureJob("csv-analysis-plan");
    const result = buildFSMFromPlan(job);

    expect.assert(result.success);

    const fsm = result.value.fsm;

    expect(fsm.id).toBe("analyze-and-report");
    expect(fsm.initial).toBe("idle");

    expect(Object.keys(fsm.states)).toEqual([
      "idle",
      "step_analyze_csv",
      "step_send_report",
      "completed",
    ]);

    expect(fsm.states.idle?.on?.["csv-uploaded"]).toMatchObject({ target: "step_analyze_csv" });

    const analyzeState = fsm.states.step_analyze_csv;
    expect(analyzeState?.entry).toHaveLength(2);
    expect(analyzeState?.entry?.[0]).toMatchObject({
      type: "agent",
      agentId: "csv-data-analyst",
      outputType: "summary",
      prompt: "Run SQL analysis on the uploaded CSV data to answer the user's question",
    });
    expect(analyzeState?.entry?.[1]).toMatchObject({ type: "emit", event: "ADVANCE" });

    expect(analyzeState?.on?.ADVANCE).toMatchObject({ target: "step_send_report" });

    const sendState = fsm.states.step_send_report;
    expect(sendState?.entry).toHaveLength(2);
    expect(sendState?.entry?.[0]).toMatchObject({
      type: "agent",
      agentId: "csv-email-reporter",
      outputType: "email-result",
      prompt: "Email the analysis summary and key findings to the specified recipient",
    });
    expect(sendState?.entry?.[1]).toMatchObject({ type: "emit", event: "ADVANCE" });

    expect(sendState?.on?.ADVANCE).toMatchObject({ target: "completed" });
    expect(fsm.states.completed?.type).toBe("final");
    expect(fsm.documentTypes?.summary).toBeDefined();
  });

  it("registers existence guard for analyze-csv step", () => {
    const job = loadFixtureJob("csv-analysis-plan");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const guard = result.value.fsm.functions?.guard_analyze_csv_done;
    expect(guard?.type).toBe("guard");
    expect(guard?.code).toContain("return context.results['analysis-output'] !== undefined;");
  });
});

// ---------------------------------------------------------------------------
// Fan-in (diamond: search-web + analyze-data → summarize-findings)
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — fan-in (diamond)", () => {
  it("compiles a diamond DAG with fan-in guard", () => {
    const job = loadFixtureJob("fan-in-plan");
    const result = buildFSMFromPlan(job);

    expect.assert(result.success);

    const fsm = result.value.fsm;

    // Topological order: analyze-data, search-web, summarize-findings (a before s lexicographically)
    expect(Object.keys(fsm.states)).toEqual([
      "idle",
      "step_analyze_data",
      "step_search_web",
      "step_summarize_findings",
      "completed",
    ]);

    // search_web's ADVANCE should have a fan-in guard for summarize_findings
    const advance = fsm.states.step_search_web?.on?.ADVANCE;
    expect(advance).toMatchObject({
      target: "step_summarize_findings",
      guards: ["guard_fan_in_summarize_findings"],
    });

    const guardName = "guard_fan_in_summarize_findings";
    const guardCode = fsm.functions?.[guardName]?.code;
    expect(guardCode).toContain("context.results['web-research-output'] !== undefined");
    expect(guardCode).toContain("context.results['data-analysis-output'] !== undefined");

    const stepSummarize = fsm.states.step_summarize_findings;

    expect(stepSummarize?.on?.ADVANCE).toMatchObject({ target: "completed" });
    expect(fsm.documentTypes?.research).toBeDefined();
    expect(fsm.documentTypes?.summary).toBeDefined();
  });

  it("analyze_data transitions to search_web with existence guard", () => {
    const job = loadFixtureJob("fan-in-plan");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const stepAnalyze = result.value.fsm.states.step_analyze_data;
    expect(stepAnalyze?.on?.ADVANCE).toMatchObject({
      target: "step_search_web",
      guards: ["guard_analyze_data_done"],
    });

    expect(result.value.fsm.functions?.guard_analyze_data_done?.code).toContain(
      "return context.results['data-analysis-output'] !== undefined;",
    );
  });
});

// ---------------------------------------------------------------------------
// Linear 3-step (ticket: read → implement → update)
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — linear-ticket (3-step)", () => {
  it("compiles a 3-step pipeline with prepare mappings", () => {
    const job = loadFixtureJob("linear-ticket-plan");
    const result = buildFSMFromPlan(job);

    expect.assert(result.success);

    const fsm = result.value.fsm;

    expect(Object.keys(fsm.states)).toEqual([
      "idle",
      "step_read_ticket",
      "step_implement_changes",
      "step_update_ticket",
      "completed",
    ]);

    const implState = fsm.states.step_implement_changes;
    expect(implState?.entry?.[0]).toMatchObject({
      type: "agent",
      agentId: "claude-code",
      prompt: "Implement the code changes described in the ticket within the specified repository",
    });

    const updateState = fsm.states.step_update_ticket;
    expect(updateState?.entry?.[0]).toMatchObject({
      type: "agent",
      agentId: "ticket-updater",
      prompt:
        "Update the ticket with the implementation results, files changed, and completion status",
    });

    expect(fsm.documentTypes?.ticket).toBeDefined();
    expect(fsm.documentTypes?.["code-result"]).toBeDefined();
    expect(fsm.documentTypes?.status).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Conditional branching (error triage: analyze → critical | routine)
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — conditional-error-triage", () => {
  it("compiles and produces correct states in topological order", () => {
    const job = loadFixtureJob("conditional-error-triage");
    const result = buildFSMFromPlan(job);

    expect.assert(result.success);

    const fsm = result.value.fsm;

    // Topo order: analyze-errors (root), alert-critical, report-routine (both depend on analyze-errors, sorted lexicographically)
    expect(Object.keys(fsm.states)).toEqual([
      "idle",
      "step_analyze_errors",
      "step_alert_critical",
      "step_report_routine",
      "completed",
    ]);
  });

  it("conditional step has guarded branch transitions instead of single ADVANCE", () => {
    const job = loadFixtureJob("conditional-error-triage");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const fsm = result.value.fsm;
    const advance = fsm.states.step_analyze_errors?.on?.ADVANCE;

    // Should be an array of guarded transitions (one per branch)
    expect.assert(Array.isArray(advance));
    expect(advance).toEqual([
      { target: "step_alert_critical", guards: ["guard_cond_analyze_errors_alert_critical"] },
      { target: "step_report_routine", guards: ["guard_cond_default_analyze_errors"] },
    ]);
  });

  it("registers guard functions for each conditional branch", () => {
    const job = loadFixtureJob("conditional-error-triage");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const fsm = result.value.fsm;

    // Critical branch guard checks field value via context.results
    const criticalGuard = fsm.functions?.guard_cond_analyze_errors_alert_critical;
    expect(criticalGuard?.type).toBe("guard");
    expect(criticalGuard?.code).toContain(
      "return context.results['error-analysis']?.summary === \"critical\";",
    );

    // Default branch guard returns true
    const defaultGuard = fsm.functions?.guard_cond_default_analyze_errors;
    expect(defaultGuard?.type).toBe("guard");
    expect(defaultGuard?.code).toContain("return true;");
    expect(defaultGuard?.code).toContain("export default function");
  });

  it("branch target steps skip over sibling branches to completed", () => {
    const job = loadFixtureJob("conditional-error-triage");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const fsm = result.value.fsm;

    // Both branch targets transition directly to "completed", skipping the sibling
    expect(fsm.states.step_alert_critical?.on?.ADVANCE).toMatchObject({ target: "completed" });
    expect(fsm.states.step_report_routine?.on?.ADVANCE).toMatchObject({ target: "completed" });
  });

  it("branch target steps have prepare actions from mappings", () => {
    const job = loadFixtureJob("conditional-error-triage");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const fsm = result.value.fsm;

    const alertEntry = fsm.states.step_alert_critical?.entry;
    expect(alertEntry?.[0]).toMatchObject({
      type: "agent",
      agentId: "slack",
      prompt: "Post critical error summary to #incidents Slack channel",
    });
    expect(alertEntry?.[1]).toMatchObject({ type: "emit", event: "ADVANCE" });

    const routineEntry = fsm.states.step_report_routine?.entry;
    expect(routineEntry?.[0]).toMatchObject({
      type: "agent",
      agentId: "email",
      prompt: "Send routine error trend report via email",
    });
    expect(routineEntry?.[1]).toMatchObject({ type: "emit", event: "ADVANCE" });
  });

  it("registers all document types from contracts", () => {
    const job = loadFixtureJob("conditional-error-triage");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    expect(result.value.fsm.documentTypes?.summary).toBeDefined();
    expect(result.value.fsm.documentTypes?.["slack-result"]).toBeDefined();
    expect(result.value.fsm.documentTypes?.["email-result"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Multi-job plan (daily-sync + process-webhook, shared agents)
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — multi-job-plan", () => {
  it("compiles each job independently", () => {
    const [job1, job2] = loadFixtureJobs("multi-job-plan");
    const result1 = buildFSMFromPlan(job1);
    const result2 = buildFSMFromPlan(job2);

    expect.assert(result1.success);
    expect.assert(result2.success);

    expect(result1.value.fsm.id).toBe("daily-sync");
    expect(result2.value.fsm.id).toBe("process-webhook");
  });

  it("each FSM uses its own trigger signal", () => {
    const [job1, job2] = loadFixtureJobs("multi-job-plan");
    const fsm1 = buildFSMFromPlan(job1);
    const fsm2 = buildFSMFromPlan(job2);
    expect.assert(fsm1.success);
    expect.assert(fsm2.success);

    expect(fsm1.value.fsm.states.idle?.on?.["daily-schedule"]).toMatchObject({
      target: "step_fetch_data",
    });
    expect(fsm2.value.fsm.states.idle?.on?.["webhook-received"]).toMatchObject({
      target: "step_parse_payload",
    });
  });

  it("FSMs have independent state sets", () => {
    const [job1, job2] = loadFixtureJobs("multi-job-plan");
    const fsm1 = buildFSMFromPlan(job1);
    const fsm2 = buildFSMFromPlan(job2);
    expect.assert(fsm1.success);
    expect.assert(fsm2.success);

    // Job 1: 3-step linear chain
    expect(Object.keys(fsm1.value.fsm.states)).toEqual([
      "idle",
      "step_fetch_data",
      "step_analyze_data",
      "step_send_notification",
      "completed",
    ]);

    // Job 2: 2-step chain
    expect(Object.keys(fsm2.value.fsm.states)).toEqual([
      "idle",
      "step_parse_payload",
      "step_send_response",
      "completed",
    ]);
  });

  it("FSMs have independent function sets", () => {
    const [job1, job2] = loadFixtureJobs("multi-job-plan");
    const fsm1 = buildFSMFromPlan(job1);
    const fsm2 = buildFSMFromPlan(job2);
    expect.assert(fsm1.success);
    expect.assert(fsm2.success);

    const fns1 = Object.keys(fsm1.value.fsm.functions ?? {});
    const fns2 = Object.keys(fsm2.value.fsm.functions ?? {});

    // Job-specific guard functions don't leak across
    expect(fns1).toContain("guard_fetch_data_done");
    expect(fns2).not.toContain("guard_fetch_data_done");

    expect(fns2).toContain("guard_parse_payload_done");
    expect(fns1).not.toContain("guard_parse_payload_done");
  });
});

// ---------------------------------------------------------------------------
// Compile warnings
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — warnings", () => {
  it("emits no_output_contract warning for steps without a documentContract", () => {
    const job: ClassifiedJobWithDAG = {
      id: "warn-test",
      name: "Warning Test",
      title: "Warnings",
      triggerSignalId: "test",
      steps: [
        {
          id: "fetch",
          agentId: "fetcher",
          description: "Fetch data",
          depends_on: [],
          executionType: "bundled",
          executionRef: "fetcher",
        },
        {
          id: "notify",
          agentId: "notifier",
          description: "Send notification",
          depends_on: ["fetch"],
          executionType: "bundled",
          executionRef: "notifier",
        },
      ],
      documentContracts: [
        {
          producerStepId: "fetch",
          documentId: "fetch-output",
          documentType: "data",
          schema: { type: "object", properties: {} },
        },
      ],
      prepareMappings: [],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    expect(result.value.warnings).toEqual([
      expect.objectContaining({
        type: "no_output_contract",
        stepId: "notify",
        agentId: "notifier",
        message: expect.stringContaining("notifier"),
      }),
    ]);
  });

  it("emits no warnings when all steps have contracts", () => {
    const job = loadFixtureJob("linear-ticket-plan");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    expect(result.value.warnings).toHaveLength(0);
  });

  it("warnings do not block successful compilation", () => {
    const job: ClassifiedJobWithDAG = {
      id: "all-no-contracts",
      name: "No Contracts",
      title: "No Contracts",
      triggerSignalId: "test",
      steps: [
        {
          id: "step-a",
          agentId: "agent-a",
          description: "A",
          depends_on: [],
          executionType: "bundled",
          executionRef: "agent-a",
        },
        {
          id: "step-b",
          agentId: "agent-b",
          description: "B",
          depends_on: ["step-a"],
          executionType: "bundled",
          executionRef: "agent-b",
        },
      ],
      documentContracts: [],
      prepareMappings: [],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    expect(result.value.warnings).toHaveLength(2);
    expect(result.value.fsm.id).toBe("all-no-contracts");
    expect(Object.keys(result.value.fsm.states)).toEqual([
      "idle",
      "step_step_a",
      "step_step_b",
      "completed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Agent action prompt passthrough
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — execution action prompt", () => {
  it("every execution action has a prompt matching its step description", () => {
    const job = loadFixtureJob("linear-ticket-plan");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const stepDescriptions = new Map(job.steps.map((s) => [s.agentId, s.description]));
    const executionActions = Object.values(result.value.fsm.states)
      .flatMap((s) => s.entry ?? [])
      .filter((a) => a.type === "agent");

    expect(executionActions.length).toBeGreaterThan(0);
    for (const action of executionActions) {
      expect(action.prompt).toBe(stepDescriptions.get(action.agentId));
    }
  });

  it("execution actions include outputType from document contract", () => {
    const job = loadFixtureJob("linear-ticket-plan");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const executionActions = Object.values(result.value.fsm.states)
      .flatMap((s) => s.entry ?? [])
      .filter((a) => a.type === "agent");

    // All steps in linear-ticket have contracts: 3 agent actions
    expect(executionActions).toHaveLength(3);
    expect(executionActions[0]).toMatchObject({
      type: "agent",
      agentId: "ticket-reader",
      outputType: "ticket",
    });
    expect(executionActions[1]).toMatchObject({
      type: "agent",
      agentId: "claude-code",
      outputType: "code-result",
    });
    expect(executionActions[2]).toMatchObject({
      type: "agent",
      agentId: "ticket-updater",
      outputType: "status",
    });
  });

  it("agent actions omit outputType when step has no contract", () => {
    const job: ClassifiedJobWithDAG = {
      id: "no-contract",
      name: "No Contract",
      title: "No Contract",
      triggerSignalId: "test",
      steps: [
        {
          id: "step-a",
          agentId: "planner-a",
          description: "A",
          depends_on: [],
          executionType: "bundled",
          executionRef: "bundled-a",
        },
      ],
      documentContracts: [],
      prepareMappings: [],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const agentActions = Object.values(result.value.fsm.states)
      .flatMap((s) => s.entry ?? [])
      .filter((a) => a.type === "agent");

    expect(agentActions).toHaveLength(1);
    expect(agentActions[0]).toMatchObject({ agentId: "planner-a" });
    expect(agentActions[0]).not.toHaveProperty("outputType");
  });
});

// ---------------------------------------------------------------------------
// Function code wrapping
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — function wrappers", () => {
  it("every function code starts with export default function", () => {
    const job = loadFixtureJob("csv-analysis-plan");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const functions = result.value.fsm.functions ?? {};
    expect(Object.keys(functions).length).toBeGreaterThan(0);
    for (const [name, fn] of Object.entries(functions)) {
      expect(fn.code, `function "${name}" missing export default wrapper`).toMatch(
        /^export default function \w+\(context, event\) \{/,
      );
    }
  });

  it("conditional guard functions are also wrapped", () => {
    const job = loadFixtureJob("conditional-error-triage");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const functions = result.value.fsm.functions ?? {};
    const condGuards = Object.entries(functions).filter(([name]) => name.startsWith("guard_cond_"));
    expect(condGuards.length).toBeGreaterThan(0);
    for (const [name, fn] of condGuards) {
      expect(fn.code, `conditional guard "${name}" missing wrapper`).toMatch(
        /^export default function \w+\(context, event\) \{/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Targeted cleanup
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — targeted cleanup", () => {
  it("cleanup contains no deleteDoc calls (engine manages results lifecycle)", () => {
    const job = loadFixtureJob("csv-analysis-plan");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const code = result.value.fsm.functions?.cleanup?.code ?? "";
    expect(code).not.toContain("deleteDoc");
  });
});

// ---------------------------------------------------------------------------
// formatCompilerWarnings
// ---------------------------------------------------------------------------

describe("formatCompilerWarnings", () => {
  it("returns empty string for no warnings", () => {
    expect(formatCompilerWarnings([])).toBe("");
  });

  it("returns empty string when all jobs have empty warnings", () => {
    expect(formatCompilerWarnings([{ jobId: "j1", warnings: [] }])).toBe("");
  });

  it("formats grouped warnings by job", () => {
    const output = formatCompilerWarnings([
      {
        jobId: "email-triage",
        warnings: [
          {
            type: "no_output_contract",
            stepId: "fetch-emails",
            agentId: "fetcher",
            message: "no contract",
          },
        ],
      },
    ]);

    expect(output).toContain("Compilation warnings (1):");
    expect(output).toContain('job "email-triage":');
    expect(output).toContain('"fetch-emails" (agent: fetcher): no output contract');
  });
});
