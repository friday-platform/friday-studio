import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClassifiedJobWithDAG } from "../planner/stamp-execution-types.ts";
import { WorkspaceBlueprintSchema } from "../types.ts";
import { buildFSMFromPlan, type CompileWarning, formatCompilerWarnings } from "./build-fsm.ts";

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
      agentId: "data-analyst",
      outputType: "summary",
      prompt: "Run SQL analysis on the uploaded CSV data to answer the user's question",
    });
    expect(analyzeState?.entry?.[1]).toMatchObject({ type: "emit", event: "ADVANCE" });

    expect(analyzeState?.on?.ADVANCE).toMatchObject({ target: "step_send_report" });

    const sendState = fsm.states.step_send_report;
    expect(sendState?.entry).toHaveLength(3);
    expect(sendState?.entry?.[0]).toMatchObject({ type: "code" });
    expect(sendState?.entry?.[1]).toMatchObject({
      type: "agent",
      agentId: "email",
      outputType: "email-result",
      prompt: "Email the analysis summary and key findings to the specified recipient",
    });
    expect(sendState?.entry?.[2]).toMatchObject({ type: "emit", event: "ADVANCE" });

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

  it("registers prepare function for send-report step", () => {
    const job = loadFixtureJob("csv-analysis-plan");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const prepareFn = result.value.fsm.functions?.prepare_send_report;
    expect(prepareFn?.type).toBe("action");
    expect(prepareFn?.code).toContain("analysis-output");
    expect(prepareFn?.code).toContain("report_body");
    expect(prepareFn?.code).toContain("subject_prefix");
  });

  it("prepare function returns { task, config } instead of creating request doc", () => {
    const job = loadFixtureJob("csv-analysis-plan");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const code = result.value.fsm.functions?.prepare_send_report?.code ?? "";
    expect(code).toContain("return { task:");
    expect(code).not.toContain("createDoc");
    expect(code).not.toContain("send-report-request");
    expect(code).not.toContain("SendReportRequest");
    expect(code).toContain("config['report_body']");
    expect(code).toContain("config['subject_prefix']");
    expect(code).toContain("Email the analysis summary");
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
    expect(stepSummarize?.entry?.[0]).toMatchObject({ type: "code" });

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
    expect(implState?.entry?.[0]).toMatchObject({ type: "code" });
    expect(implState?.entry?.[1]).toMatchObject({
      type: "agent",
      agentId: "claude-code",
      prompt: "Implement the code changes described in the ticket within the specified repository",
    });

    const updateState = fsm.states.step_update_ticket;
    expect(updateState?.entry?.[0]).toMatchObject({ type: "code" });
    expect(updateState?.entry?.[1]).toMatchObject({
      type: "llm",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      prompt:
        "Update the ticket with the implementation results, files changed, and completion status",
      tools: ["linear"],
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
    expect(alertEntry?.[0]).toMatchObject({ type: "code" });
    expect(alertEntry?.[1]).toMatchObject({
      type: "agent",
      agentId: "slack",
      prompt: "Post critical error summary to #incidents Slack channel",
    });
    expect(alertEntry?.[2]).toMatchObject({ type: "emit", event: "ADVANCE" });

    const routineEntry = fsm.states.step_report_routine?.entry;
    expect(routineEntry?.[0]).toMatchObject({ type: "code" });
    expect(routineEntry?.[1]).toMatchObject({
      type: "agent",
      agentId: "email",
      prompt: "Send routine error trend report via email",
    });
    expect(routineEntry?.[2]).toMatchObject({ type: "emit", event: "ADVANCE" });
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

    // cleanup is in both (shared name, separate instances)
    expect(fns1).toContain("cleanup");
    expect(fns2).toContain("cleanup");

    // Job-specific functions don't leak across
    expect(fns1).toContain("prepare_analyze_data");
    expect(fns1).toContain("prepare_send_notification");
    expect(fns2).not.toContain("prepare_analyze_data");

    expect(fns2).toContain("prepare_send_response");
    expect(fns1).not.toContain("prepare_send_response");
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

  it("emits invalid_prepare_path warning for bad mapping paths", () => {
    const job: ClassifiedJobWithDAG = {
      id: "bad-path",
      name: "Bad Path",
      title: "Bad Path",
      triggerSignalId: "test",
      steps: [
        {
          id: "produce",
          agentId: "producer",
          description: "Produce",
          depends_on: [],
          executionType: "bundled",
          executionRef: "producer",
        },
        {
          id: "consume",
          agentId: "consumer",
          description: "Consume",
          depends_on: ["produce"],
          executionType: "bundled",
          executionRef: "consumer",
        },
      ],
      documentContracts: [
        {
          producerStepId: "produce",
          documentId: "produce-output",
          documentType: "data",
          schema: {
            type: "object",
            properties: { title: { type: "string" }, body: { type: "string" } },
          },
        },
      ],
      prepareMappings: [
        {
          consumerStepId: "consume",
          documentId: "produce-output",
          documentType: "data",
          sources: [
            { from: "title", to: "heading" },
            { from: "nonexistent_field", to: "content" },
          ],
          constants: [],
        },
      ],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const pathWarnings = result.value.warnings.filter(
      (w): w is CompileWarning & { type: "invalid_prepare_path" } =>
        w.type === "invalid_prepare_path",
    );
    expect(pathWarnings).toEqual([
      expect.objectContaining({
        type: "invalid_prepare_path",
        stepId: "consume",
        documentId: "produce-output",
        path: "nonexistent_field",
        available: ["title", "body"],
      }),
    ]);
  });

  it("skips path validation when mapping references a document with no contract", () => {
    const job: ClassifiedJobWithDAG = {
      id: "no-contract-mapping",
      name: "No Contract",
      title: "No Contract",
      triggerSignalId: "test",
      steps: [
        {
          id: "produce",
          agentId: "producer",
          description: "Produce",
          depends_on: [],
          executionType: "bundled",
          executionRef: "producer",
        },
        {
          id: "consume",
          agentId: "consumer",
          description: "Consume",
          depends_on: ["produce"],
          executionType: "bundled",
          executionRef: "consumer",
        },
      ],
      documentContracts: [],
      prepareMappings: [
        {
          consumerStepId: "consume",
          documentId: "ghost-doc",
          documentType: "data",
          sources: [{ from: "anything", to: "whatever" }],
          constants: [],
        },
      ],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    // Should have no_output_contract warnings but no path warnings
    const pathWarnings = result.value.warnings.filter((w) => w.type === "invalid_prepare_path");
    expect(pathWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Array path handling in prepare functions
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — array path code generation", () => {
  function buildWithArrayPath(fromPath: string) {
    const job: ClassifiedJobWithDAG = {
      id: "array-path",
      name: "Array Path",
      title: "Array Path",
      triggerSignalId: "test",
      steps: [
        {
          id: "produce",
          agentId: "producer",
          description: "Produce",
          depends_on: [],
          executionType: "bundled",
          executionRef: "producer",
        },
        {
          id: "consume",
          agentId: "consumer",
          description: "Consume",
          depends_on: ["produce"],
          executionType: "bundled",
          executionRef: "consumer",
        },
      ],
      documentContracts: [
        {
          producerStepId: "produce",
          documentId: "produce-output",
          documentType: "data",
          schema: {
            type: "object",
            properties: {
              products: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    brand: { type: "string" },
                    tags: {
                      type: "array",
                      items: { type: "object", properties: { label: { type: "string" } } },
                    },
                  },
                },
              },
              summary: { type: "string" },
            },
          },
        },
      ],
      prepareMappings: [
        {
          consumerStepId: "consume",
          documentId: "produce-output",
          documentType: "data",
          sources: [{ from: fromPath, to: "result" }],
          constants: [],
        },
      ],
    };
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);
    return result.value.fsm.functions?.prepare_consume?.code ?? "";
  }

  it("generates valid JS for simple dot-path (no arrays)", () => {
    const code = buildWithArrayPath("summary");
    expect(code).toContain("context.results['produce-output']?.summary");
    expect(code).not.toContain("[]");
  });

  it("generates .map() for single-level array path", () => {
    const code = buildWithArrayPath("products[].brand");
    expect(code).toContain("?.products?.map(");
    expect(code).toContain("?.brand");
    expect(code).not.toContain("[]");
  });

  it("generates .flatMap() + .map() for nested array path", () => {
    const code = buildWithArrayPath("products[].tags[].label");
    expect(code).toContain("?.products?.flatMap(");
    expect(code).toContain("?.tags?.map(");
    expect(code).toContain("?.label");
    expect(code).not.toContain("[]");
  });

  it("generated code is syntactically valid JavaScript", () => {
    const paths = ["summary", "products[].brand", "products[].tags[].label"];
    for (const path of paths) {
      const code = buildWithArrayPath(path);
      // Strip `export default` so Function constructor can parse the body
      const body = code.replace(/^export default /, "");
      expect(() => new Function(body)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Redundant array element projection deduplication
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — array projection deduplication", () => {
  it("drops element projections when full array is already mapped", () => {
    const job: ClassifiedJobWithDAG = {
      id: "dedup-test",
      name: "Dedup Test",
      title: "Dedup",
      triggerSignalId: "test",
      steps: [
        {
          id: "fetch",
          agentId: "fetcher",
          description: "Fetch PRs",
          depends_on: [],
          executionType: "bundled",
          executionRef: "fetcher",
        },
        {
          id: "categorize",
          agentId: "categorizer",
          description: "Categorize PRs",
          depends_on: ["fetch"],
          executionType: "bundled",
          executionRef: "categorizer",
        },
      ],
      documentContracts: [
        {
          producerStepId: "fetch",
          documentId: "fetch-output",
          documentType: "pr-list",
          schema: {
            type: "object",
            properties: {
              pull_requests: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    author: { type: "string" },
                    url: { type: "string" },
                  },
                },
              },
            },
          },
        },
      ],
      prepareMappings: [
        {
          consumerStepId: "categorize",
          documentId: "fetch-output",
          documentType: "pr-list",
          sources: [
            { from: "pull_requests", to: "pull_requests" },
            { from: "pull_requests[].title", to: "pull_requests[].title" },
            { from: "pull_requests[].author", to: "pull_requests[].author" },
            { from: "pull_requests[].url", to: "pull_requests[].url" },
          ],
          constants: [],
        },
      ],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const code = result.value.fsm.functions?.prepare_categorize?.code ?? "";

    expect(code).toContain("config['pull_requests']");
    expect(code).not.toContain("pull_requests[].title");
    expect(code).not.toContain("pull_requests[].author");
    expect(code).not.toContain(".map(");
  });

  it("keeps element projections when full array is NOT mapped", () => {
    const job: ClassifiedJobWithDAG = {
      id: "no-dedup",
      name: "No Dedup",
      title: "No Dedup",
      triggerSignalId: "test",
      steps: [
        {
          id: "fetch",
          agentId: "fetcher",
          description: "Fetch",
          depends_on: [],
          executionType: "bundled",
          executionRef: "fetcher",
        },
        {
          id: "consume",
          agentId: "consumer",
          description: "Consume",
          depends_on: ["fetch"],
          executionType: "bundled",
          executionRef: "consumer",
        },
      ],
      documentContracts: [
        {
          producerStepId: "fetch",
          documentId: "fetch-output",
          documentType: "data",
          schema: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: { type: "string" }, price: { type: "number" } },
                },
              },
            },
          },
        },
      ],
      prepareMappings: [
        {
          consumerStepId: "consume",
          documentId: "fetch-output",
          documentType: "data",
          sources: [
            { from: "items[].name", to: "names" },
            { from: "items[].price", to: "prices" },
          ],
          constants: [],
        },
      ],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const code = result.value.fsm.functions?.prepare_consume?.code ?? "";

    expect(code).toContain("config['names']");
    expect(code).toContain("config['prices']");
    expect(code).toContain(".map(");
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
      .filter((a) => a.type === "agent" || a.type === "llm");

    expect(executionActions.length).toBeGreaterThan(0);
    for (const action of executionActions) {
      const key = action.type === "agent" ? action.agentId : undefined;
      if (key) {
        expect(action.prompt).toBe(stepDescriptions.get(key));
      } else {
        // LLM actions don't carry agentId — verify prompt matches some step description
        expect([...stepDescriptions.values()]).toContain(action.prompt);
      }
    }
  });

  it("execution actions include outputType from document contract", () => {
    const job = loadFixtureJob("linear-ticket-plan");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const executionActions = Object.values(result.value.fsm.states)
      .flatMap((s) => s.entry ?? [])
      .filter((a) => a.type === "agent" || a.type === "llm");

    // All steps in linear-ticket have contracts: 2 LLM + 1 bundled
    expect(executionActions).toHaveLength(3);
    expect(executionActions[0]).toMatchObject({ type: "llm", outputType: "ticket" });
    expect(executionActions[1]).toMatchObject({
      type: "agent",
      agentId: "claude-code",
      outputType: "code-result",
    });
    expect(executionActions[2]).toMatchObject({ type: "llm", outputType: "status" });
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
    expect(agentActions[0]).toMatchObject({ agentId: "bundled-a" });
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
// Entry action ordering
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — entry action ordering", () => {
  it("entry order is prepare -> agent -> emit", () => {
    const job = loadFixtureJob("linear-ticket-plan");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const entry = result.value.fsm.states.step_implement_changes?.entry ?? [];
    const types = entry.map((a) => (a.type === "code" ? `code:${a.function}` : a.type));
    expect(types).toEqual(["code:prepare_implement_changes", "agent", "emit"]);
  });
});

// ---------------------------------------------------------------------------
// Transform expression codegen
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — transform codegen", () => {
  /** Helper to build a job with specific sources and return the prepare function code */
  function buildPrepareCode(
    sources: Array<{ from: string; to: string; transform?: string; description?: string }>,
    schemaOverride?: Record<string, unknown>,
  ): string {
    const job: ClassifiedJobWithDAG = {
      id: "transform-test",
      name: "Transform Test",
      title: "Transform Test",
      triggerSignalId: "test",
      steps: [
        {
          id: "produce",
          agentId: "producer",
          description: "Produce",
          depends_on: [],
          executionType: "bundled",
          executionRef: "producer",
        },
        {
          id: "consume",
          agentId: "consumer",
          description: "Consume",
          depends_on: ["produce"],
          executionType: "bundled",
          executionRef: "consumer",
        },
      ],
      documentContracts: [
        {
          producerStepId: "produce",
          documentId: "produce-output",
          documentType: "data",
          schema: schemaOverride ?? {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
          },
        },
      ],
      prepareMappings: [
        {
          consumerStepId: "consume",
          documentId: "produce-output",
          documentType: "data",
          sources,
          constants: [],
        },
      ],
    };
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);
    return result.value.fsm.functions?.prepare_consume?.code ?? "";
  }

  it("plain extraction produces no docs preamble or IIFE", () => {
    const code = buildPrepareCode([{ from: "summary", to: "report_body" }]);
    expect(code).not.toContain("const docs =");
    expect(code).not.toContain("(() => {");
    expect(code).toContain("config['report_body'] = context.results['produce-output']?.summary;");
  });

  it("transform source uses IIFE with value binding", () => {
    const code = buildPrepareCode([
      {
        from: "summary",
        to: "word_count",
        transform: "value.split(' ').length",
        description: "Count words in summary",
      },
    ]);
    expect(code).toContain("config['word_count'] = (() => {");
    expect(code).toContain("const value = context.results['produce-output']?.summary;");
    expect(code).toContain("return value.split(' ').length;");
    expect(code).toContain("})();");
  });

  it("transform source includes undefined guard", () => {
    const code = buildPrepareCode([
      {
        from: "summary",
        to: "upper",
        transform: "value.toUpperCase()",
        description: "Uppercase summary",
      },
    ]);
    expect(code).toContain(
      "if (value === undefined) throw new Error(\"Source field 'summary' not found in 'produce-output'\");",
    );
  });

  it("docs preamble emitted when any source has a transform", () => {
    const code = buildPrepareCode([
      { from: "summary", to: "total", transform: "value.length", description: "Count chars" },
    ]);
    expect(code).toContain("const docs = context.results;");
  });

  it("docs preamble NOT emitted when no sources have transforms", () => {
    const code = buildPrepareCode([{ from: "summary", to: "report_body" }]);
    expect(code).not.toContain("const docs =");
  });

  it("mixed mappings: plain extraction and transforms coexist", () => {
    const code = buildPrepareCode([
      { from: "summary", to: "report_body" },
      {
        from: "summary",
        to: "word_count",
        transform: "value.split(' ').length",
        description: "Count words",
      },
    ]);
    expect(code).toContain("config['report_body'] = context.results['produce-output']?.summary;");
    expect(code).toContain("config['word_count'] = (() => {");
    expect(code).toContain("const docs = context.results;");
  });

  it("cross-document transform can reference docs object", () => {
    const code = buildPrepareCode([
      {
        from: "summary",
        to: "taxed",
        transform: "value.length * docs['tax-config'].rate",
        description: "Apply tax rate from another document",
      },
    ]);
    expect(code).toContain("return value.length * docs['tax-config'].rate;");
    expect(code).toContain("const docs = context.results;");
  });

  it("generated transform code is syntactically valid JavaScript", () => {
    const expressions = [
      "value.split(' ').length",
      "value.reduce((sum, i) => sum + i.amount, 0)",
      "value.length * docs['tax-config'].rate",
    ];
    for (const expr of expressions) {
      const code = buildPrepareCode([
        { from: "summary", to: "result", transform: expr, description: "test" },
      ]);
      const body = code.replace(/^export default /, "");
      expect(() => new Function(body), `Expression "${expr}" produced invalid JS`).not.toThrow();
    }
  });

  it("non-required field transform returns undefined instead of throwing", () => {
    const schema = {
      type: "object",
      properties: { summary: { type: "string" }, key_contacts: { type: "string" } },
      required: ["summary"],
    };
    const code = buildPrepareCode(
      [
        {
          from: "key_contacts",
          to: "contacts_upper",
          transform: "value.toUpperCase()",
          description: "Uppercase contacts",
        },
      ],
      schema,
    );
    expect(code).toContain("if (value === undefined) return undefined;");
    expect(code).not.toContain("throw new Error");
  });

  it("required field transform still throws on undefined", () => {
    const schema = {
      type: "object",
      properties: { summary: { type: "string" }, key_contacts: { type: "string" } },
      required: ["summary"],
    };
    const code = buildPrepareCode(
      [
        {
          from: "summary",
          to: "upper_summary",
          transform: "value.toUpperCase()",
          description: "Uppercase summary",
        },
      ],
      schema,
    );
    expect(code).toContain("if (value === undefined) throw new Error");
    expect(code).not.toContain("return undefined;");
  });
});

// ---------------------------------------------------------------------------
// Transform codegen snapshots (regression guard for exact generated code)
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — transform codegen snapshots", () => {
  /** Helper to build a job with specific sources and return the prepare function code */
  function buildPrepareCode(
    sources: Array<{ from: string; to: string; transform?: string; description?: string }>,
    constants: Array<{ key: string; value: unknown }> = [],
  ): string {
    const job: ClassifiedJobWithDAG = {
      id: "transform-test",
      name: "Transform Test",
      title: "Transform Test",
      triggerSignalId: "test",
      steps: [
        {
          id: "produce",
          agentId: "producer",
          description: "Produce",
          depends_on: [],
          executionType: "bundled",
          executionRef: "producer",
        },
        {
          id: "consume",
          agentId: "consumer",
          description: "Consume",
          depends_on: ["produce"],
          executionType: "bundled",
          executionRef: "consumer",
        },
      ],
      documentContracts: [
        {
          producerStepId: "produce",
          documentId: "produce-output",
          documentType: "data",
          schema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
          },
        },
      ],
      prepareMappings: [
        {
          consumerStepId: "consume",
          documentId: "produce-output",
          documentType: "data",
          sources,
          constants,
        },
      ],
    };
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);
    return result.value.fsm.functions?.prepare_consume?.code ?? "";
  }

  it("plain extraction only — no docs preamble, no IIFEs", () => {
    const code = buildPrepareCode([{ from: "summary", to: "report_body" }]);
    expect(code).toMatchInlineSnapshot(`
      "export default function prepare_consume(context, event) {
        const config = {};
        config['report_body'] = context.results['produce-output']?.summary;
        return { task: 'Consume', config };
      }"
    `);
  });

  it("transform only — docs preamble, IIFE with undefined guard", () => {
    const code = buildPrepareCode([
      {
        from: "summary",
        to: "word_count",
        transform: "value.split(' ').length",
        description: "Count words in summary",
      },
    ]);
    expect(code).toMatchInlineSnapshot(`
      "export default function prepare_consume(context, event) {
        const config = {};
        const docs = context.results;
        config['word_count'] = (() => {
          const value = context.results['produce-output']?.summary;
          if (value === undefined) throw new Error("Source field 'summary' not found in 'produce-output'");
          return value.split(' ').length;
        })();
        return { task: 'Consume', config };
      }"
    `);
  });

  it("mixed — plain extraction + transform coexist", () => {
    const code = buildPrepareCode([
      { from: "summary", to: "report_body" },
      {
        from: "summary",
        to: "word_count",
        transform: "value.split(' ').length",
        description: "Count words",
      },
    ]);
    expect(code).toMatchInlineSnapshot(`
      "export default function prepare_consume(context, event) {
        const config = {};
        const docs = context.results;
        config['report_body'] = context.results['produce-output']?.summary;
        config['word_count'] = (() => {
          const value = context.results['produce-output']?.summary;
          if (value === undefined) throw new Error("Source field 'summary' not found in 'produce-output'");
          return value.split(' ').length;
        })();
        return { task: 'Consume', config };
      }"
    `);
  });

  it("cross-document transform referencing docs['other-doc']", () => {
    const code = buildPrepareCode([
      {
        from: "summary",
        to: "taxed",
        transform: "value.length * docs['tax-config'].rate",
        description: "Apply tax rate from another document",
      },
    ]);
    expect(code).toMatchInlineSnapshot(`
      "export default function prepare_consume(context, event) {
        const config = {};
        const docs = context.results;
        config['taxed'] = (() => {
          const value = context.results['produce-output']?.summary;
          if (value === undefined) throw new Error("Source field 'summary' not found in 'produce-output'");
          return value.length * docs['tax-config'].rate;
        })();
        return { task: 'Consume', config };
      }"
    `);
  });

  it("fixture: csv-analysis prepare_send_report matches snapshot", () => {
    const job = loadFixtureJob("csv-analysis-plan");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const code = result.value.fsm.functions?.prepare_send_report?.code ?? "";
    expect(code).toMatchInlineSnapshot(`
      "export default function prepare_send_report(context, event) {
        const config = {};
        config['report_body'] = context.results['analysis-output']?.summary;
        config['query_log'] = context.results['analysis-output']?.queries;
        config['subject_prefix'] = "[CSV Analysis]";
        return { task: 'Email the analysis summary and key findings to the specified recipient', config };
      }"
    `);
  });

  it("fixture: fan-in prepare_summarize_findings matches snapshot", () => {
    const job = loadFixtureJob("fan-in-plan");
    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const code = result.value.fsm.functions?.prepare_summarize_findings?.code ?? "";
    expect(code).toMatchInlineSnapshot(`
      "export default function prepare_summarize_findings(context, event) {
        const config = {};
        config['web_findings'] = context.results['web-research-output']?.response;
        config['data_findings'] = context.results['data-analysis-output']?.summary;
        return { task: 'Consolidate findings from web research and data analysis into a briefing', config };
      }"
    `);
  });
});

// ---------------------------------------------------------------------------
// Invalid prepare path filtering (sources dropped, not passed to codegen)
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — invalid path filtering", () => {
  it("drops invalid sources from generated prepare code", () => {
    const job: ClassifiedJobWithDAG = {
      id: "filter-test",
      name: "Filter Test",
      title: "Filter",
      triggerSignalId: "test",
      steps: [
        {
          id: "produce",
          agentId: "producer",
          description: "Produce",
          depends_on: [],
          executionType: "bundled",
          executionRef: "producer",
        },
        {
          id: "consume",
          agentId: "consumer",
          description: "Consume",
          depends_on: ["produce"],
          executionType: "bundled",
          executionRef: "consumer",
        },
      ],
      documentContracts: [
        {
          producerStepId: "produce",
          documentId: "produce-output",
          documentType: "data",
          schema: {
            type: "object",
            properties: { title: { type: "string" }, body: { type: "string" } },
          },
        },
      ],
      prepareMappings: [
        {
          consumerStepId: "consume",
          documentId: "produce-output",
          documentType: "data",
          sources: [
            { from: "title", to: "heading" },
            { from: "nonexistent_field", to: "content" },
          ],
          constants: [],
        },
      ],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const pathWarnings = result.value.warnings.filter((w) => w.type === "invalid_prepare_path");
    expect(pathWarnings).toHaveLength(1);

    const prepareCode = result.value.fsm.functions?.prepare_consume?.code ?? "";
    expect(prepareCode).toContain("config['heading']");
    expect(prepareCode).not.toContain("nonexistent_field");
    expect(prepareCode).not.toContain("config['content']");
  });

  it("skips prepare function entirely when all sources are invalid", () => {
    const job: ClassifiedJobWithDAG = {
      id: "all-invalid",
      name: "All Invalid",
      title: "All Invalid",
      triggerSignalId: "test",
      steps: [
        {
          id: "produce",
          agentId: "producer",
          description: "Produce",
          depends_on: [],
          executionType: "bundled",
          executionRef: "producer",
        },
        {
          id: "consume",
          agentId: "consumer",
          description: "Consume",
          depends_on: ["produce"],
          executionType: "bundled",
          executionRef: "consumer",
        },
      ],
      documentContracts: [
        {
          producerStepId: "produce",
          documentId: "produce-output",
          documentType: "data",
          schema: { type: "object", properties: { title: { type: "string" } } },
        },
      ],
      prepareMappings: [
        {
          consumerStepId: "consume",
          documentId: "produce-output",
          documentType: "data",
          sources: [
            { from: "bad_field_1", to: "a" },
            { from: "bad_field_2", to: "b" },
          ],
          constants: [],
        },
      ],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    // Two invalid path warnings
    expect(result.value.warnings.filter((w) => w.type === "invalid_prepare_path")).toHaveLength(2);

    // No prepare function registered (all sources invalid, no constants)
    expect(result.value.fsm.functions?.prepare_consume).toBeUndefined();

    // Entry actions should NOT include prepare
    const consumeEntry = result.value.fsm.states.step_consume?.entry ?? [];
    const prepareActions = consumeEntry.filter(
      (a) => a.type === "code" && a.function === "prepare_consume",
    );
    expect(prepareActions).toHaveLength(0);
  });

  it("keeps constants even when all sources are invalid", () => {
    const job: ClassifiedJobWithDAG = {
      id: "constants-only",
      name: "Constants Only",
      title: "Constants",
      triggerSignalId: "test",
      steps: [
        {
          id: "produce",
          agentId: "producer",
          description: "Produce",
          depends_on: [],
          executionType: "bundled",
          executionRef: "producer",
        },
        {
          id: "consume",
          agentId: "consumer",
          description: "Consume",
          depends_on: ["produce"],
          executionType: "bundled",
          executionRef: "consumer",
        },
      ],
      documentContracts: [
        {
          producerStepId: "produce",
          documentId: "produce-output",
          documentType: "data",
          schema: { type: "object", properties: { title: { type: "string" } } },
        },
      ],
      prepareMappings: [
        {
          consumerStepId: "consume",
          documentId: "produce-output",
          documentType: "data",
          sources: [{ from: "bad_field", to: "x" }],
          constants: [{ key: "mode", value: "strict" }],
        },
      ],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    // Prepare function exists because constants are present
    const prepareCode = result.value.fsm.functions?.prepare_consume?.code ?? "";
    expect(prepareCode).toContain("config['mode'] = \"strict\"");
    // Invalid source NOT in generated code
    expect(prepareCode).not.toContain("bad_field");
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
          {
            type: "invalid_prepare_path",
            stepId: "summarize",
            documentId: "step-0-output",
            path: "emails.body",
            available: ["emails.metadata"],
            message: "bad path",
          },
        ],
      },
    ]);

    expect(output).toContain("Compilation warnings (2):");
    expect(output).toContain('job "email-triage":');
    expect(output).toContain('"fetch-emails" (agent: fetcher): no output contract');
    expect(output).toContain('"summarize": invalid prepare path "emails.body"');
  });
});

// ---------------------------------------------------------------------------
// Permissive schemas — additionalProperties: true, minimal required
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — permissive schemas", () => {
  it("compiles schemas with additionalProperties: true", () => {
    const job: ClassifiedJobWithDAG = {
      id: "permissive",
      name: "Permissive",
      title: "Permissive",
      triggerSignalId: "test",
      steps: [
        {
          id: "analyze",
          agentId: "analyst",
          description: "Analyze data",
          depends_on: [],
          executionType: "bundled",
          executionRef: "analyst",
        },
        {
          id: "report",
          agentId: "reporter",
          description: "Send report",
          depends_on: ["analyze"],
          executionType: "bundled",
          executionRef: "reporter",
        },
      ],
      documentContracts: [
        {
          producerStepId: "analyze",
          documentId: "analysis-output",
          documentType: "summary",
          schema: {
            type: "object",
            properties: {
              summary: { type: "string", description: "Analysis findings" },
              findings: { type: "string", description: "Detailed analysis" },
            },
            required: ["summary"],
            additionalProperties: true,
          },
        },
        {
          producerStepId: "report",
          documentId: "report-output",
          documentType: "report",
          schema: {
            type: "object",
            properties: { status: { type: "string" } },
            required: ["status"],
            additionalProperties: true,
          },
        },
      ],
      prepareMappings: [
        {
          consumerStepId: "report",
          documentId: "analysis-output",
          documentType: "summary",
          sources: [
            { from: "summary", to: "report_body" },
            { from: "findings", to: "details" },
          ],
          constants: [],
        },
      ],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    expect(Object.keys(result.value.fsm.states)).toEqual([
      "idle",
      "step_analyze",
      "step_report",
      "completed",
    ]);

    const prepareCode = result.value.fsm.functions?.prepare_report?.code ?? "";
    expect(prepareCode).toContain(
      "config['report_body'] = context.results['analysis-output']?.summary;",
    );
    expect(prepareCode).toContain(
      "config['details'] = context.results['analysis-output']?.findings;",
    );

    const pathWarnings = result.value.warnings.filter((w) => w.type === "invalid_prepare_path");
    expect(pathWarnings).toHaveLength(0);
  });

  it("validates paths against declared properties, not additionalProperties", () => {
    const job: ClassifiedJobWithDAG = {
      id: "permissive-invalid",
      name: "Permissive Invalid",
      title: "Permissive Invalid",
      triggerSignalId: "test",
      steps: [
        {
          id: "produce",
          agentId: "producer",
          description: "Produce",
          depends_on: [],
          executionType: "bundled",
          executionRef: "producer",
        },
        {
          id: "consume",
          agentId: "consumer",
          description: "Consume",
          depends_on: ["produce"],
          executionType: "bundled",
          executionRef: "consumer",
        },
      ],
      documentContracts: [
        {
          producerStepId: "produce",
          documentId: "produce-output",
          documentType: "data",
          schema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
            additionalProperties: true,
          },
        },
      ],
      prepareMappings: [
        {
          consumerStepId: "consume",
          documentId: "produce-output",
          documentType: "data",
          sources: [
            { from: "summary", to: "text" },
            { from: "unknown_field", to: "extra" },
          ],
          constants: [],
        },
      ],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    // Path validation warns on undeclared field even with additionalProperties: true
    const pathWarnings = result.value.warnings.filter((w) => w.type === "invalid_prepare_path");
    expect(pathWarnings).toHaveLength(1);
    expect(pathWarnings[0]).toMatchObject({ path: "unknown_field", documentId: "produce-output" });

    // Valid path still generates code, invalid path is dropped
    const prepareCode = result.value.fsm.functions?.prepare_consume?.code ?? "";
    expect(prepareCode).toContain("config['text']");
    expect(prepareCode).not.toContain("unknown_field");
  });

  it("compiles array_of_objects schemas with additionalProperties on items", () => {
    const job: ClassifiedJobWithDAG = {
      id: "permissive-array",
      name: "Permissive Array",
      title: "Permissive Array",
      triggerSignalId: "test",
      steps: [
        {
          id: "fetch",
          agentId: "fetcher",
          description: "Fetch emails",
          depends_on: [],
          executionType: "bundled",
          executionRef: "fetcher",
        },
        {
          id: "summarize",
          agentId: "summarizer",
          description: "Summarize emails",
          depends_on: ["fetch"],
          executionType: "bundled",
          executionRef: "summarizer",
        },
      ],
      documentContracts: [
        {
          producerStepId: "fetch",
          documentId: "fetch-output",
          documentType: "emails",
          schema: {
            type: "object",
            properties: {
              emails: {
                type: "array",
                items: {
                  type: "object",
                  properties: { subject: { type: "string" }, sender: { type: "string" } },
                  additionalProperties: true,
                },
              },
            },
            required: ["emails"],
            additionalProperties: true,
          },
        },
      ],
      prepareMappings: [
        {
          consumerStepId: "summarize",
          documentId: "fetch-output",
          documentType: "emails",
          sources: [
            { from: "emails[].subject", to: "subjects" },
            { from: "emails[].sender", to: "senders" },
          ],
          constants: [],
        },
      ],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const prepareCode = result.value.fsm.functions?.prepare_summarize?.code ?? "";
    expect(prepareCode).toContain("?.emails?.map(");
    expect(prepareCode).toContain("?.subject");
    expect(prepareCode).toContain("?.sender");

    const pathWarnings = result.value.warnings.filter((w) => w.type === "invalid_prepare_path");
    expect(pathWarnings).toHaveLength(0);
  });

  it("minimal required fields — prepare functions resolve non-required properties", () => {
    const job: ClassifiedJobWithDAG = {
      id: "minimal-required",
      name: "Minimal Required",
      title: "Minimal Required",
      triggerSignalId: "test",
      steps: [
        {
          id: "analyze",
          agentId: "analyst",
          description: "Analyze",
          depends_on: [],
          executionType: "bundled",
          executionRef: "analyst",
        },
        {
          id: "report",
          agentId: "reporter",
          description: "Report",
          depends_on: ["analyze"],
          executionType: "bundled",
          executionRef: "reporter",
        },
      ],
      documentContracts: [
        {
          producerStepId: "analyze",
          documentId: "analysis-output",
          documentType: "analysis",
          schema: {
            type: "object",
            properties: {
              summary: { type: "string" },
              metrics: { type: "string" },
              recommendations: { type: "string" },
            },
            required: ["summary"],
            additionalProperties: true,
          },
        },
        {
          producerStepId: "report",
          documentId: "report-output",
          documentType: "report",
          schema: {
            type: "object",
            properties: { status: { type: "string" } },
            required: ["status"],
            additionalProperties: true,
          },
        },
      ],
      prepareMappings: [
        {
          consumerStepId: "report",
          documentId: "analysis-output",
          documentType: "analysis",
          sources: [
            { from: "summary", to: "body" },
            { from: "metrics", to: "data" },
            { from: "recommendations", to: "actions" },
          ],
          constants: [],
        },
      ],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const prepareCode = result.value.fsm.functions?.prepare_report?.code ?? "";
    expect(prepareCode).toContain("config['body'] = context.results['analysis-output']?.summary;");
    expect(prepareCode).toContain("config['data'] = context.results['analysis-output']?.metrics;");
    expect(prepareCode).toContain(
      "config['actions'] = context.results['analysis-output']?.recommendations;",
    );

    expect(result.value.warnings).toHaveLength(0);
    expect(prepareCode).toContain("?.metrics");
  });
});

// ---------------------------------------------------------------------------
// Signal → root step prepare functions
// ---------------------------------------------------------------------------

describe("buildFSMFromPlan — signal prepare mappings", () => {
  it("generates event.data access for signal-sourced prepare mappings", () => {
    const job: ClassifiedJobWithDAG = {
      id: "signal-wiring",
      name: "Signal Wiring",
      title: "Signal",
      triggerSignalId: "test-signal",
      steps: [
        {
          id: "process",
          agentId: "processor",
          description: "Process signal data",
          depends_on: [],
          executionType: "llm",
          executionRef: "processor",
        },
      ],
      documentContracts: [
        {
          producerStepId: "process",
          documentId: "process-output",
          documentType: "result",
          schema: { type: "object", properties: { status: { type: "string" } } },
        },
      ],
      prepareMappings: [
        {
          consumerStepId: "process",
          documentId: "__trigger_signal__",
          documentType: "trigger-signal",
          sources: [
            { from: "name", to: "name" },
            { from: "count", to: "count" },
          ],
          constants: [],
        },
      ],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    const prepareCode = result.value.fsm.functions?.prepare_process?.code ?? "";
    expect(prepareCode).toContain("event.data?.name");
    expect(prepareCode).toContain("event.data?.count");
    expect(prepareCode).not.toContain("context.results");
  });

  it("mixes signal and step-sourced mappings in multi-step job", () => {
    const job: ClassifiedJobWithDAG = {
      id: "mixed-sources",
      name: "Mixed",
      title: "Mixed",
      triggerSignalId: "test-signal",
      steps: [
        {
          id: "ingest",
          agentId: "ingester",
          description: "Ingest signal data",
          depends_on: [],
          executionType: "llm",
          executionRef: "ingester",
        },
        {
          id: "transform",
          agentId: "transformer",
          description: "Transform data",
          depends_on: ["ingest"],
          executionType: "llm",
          executionRef: "transformer",
        },
      ],
      documentContracts: [
        {
          producerStepId: "ingest",
          documentId: "ingest-output",
          documentType: "data",
          schema: { type: "object", properties: { result: { type: "string" } } },
        },
      ],
      prepareMappings: [
        {
          consumerStepId: "ingest",
          documentId: "__trigger_signal__",
          documentType: "trigger-signal",
          sources: [{ from: "query", to: "query" }],
          constants: [],
        },
        {
          consumerStepId: "transform",
          documentId: "ingest-output",
          documentType: "data",
          sources: [{ from: "result", to: "input" }],
          constants: [],
        },
      ],
    };

    const result = buildFSMFromPlan(job);
    expect.assert(result.success);

    // Root step reads from event.data
    const ingestPrepare = result.value.fsm.functions?.prepare_ingest?.code ?? "";
    expect(ingestPrepare).toContain("event.data?.query");
    expect(ingestPrepare).not.toContain("context.results");

    // Non-root step reads from context.results
    const transformPrepare = result.value.fsm.functions?.prepare_transform?.code ?? "";
    expect(transformPrepare).toContain("context.results['ingest-output']?.result");
    expect(transformPrepare).not.toContain("event.data");
  });
});
