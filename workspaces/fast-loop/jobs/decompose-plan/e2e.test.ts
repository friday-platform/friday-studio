/**
 * E2E smoke test for the decompose-plan pipeline.
 *
 * Exercises the full signal → FSM → agent → integrity → apply path
 * with a mocked claude-code agent and mocked HTTP layer.
 * Covers happy-path (autopilot-backlog) and dry_run (dry-run-decompositions).
 */

import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InMemoryDocumentStore } from "../../../../packages/document-store/node.ts";
import type { CodeExecutor } from "../../../../packages/fsm-engine/fsm-engine.ts";
import { FSMEngine } from "../../../../packages/fsm-engine/fsm-engine.ts";
import type { Context, FSMDefinition, Signal } from "../../../../packages/fsm-engine/types.ts";
import { checkIntegrity } from "./integrity.ts";
import { buildBatchId, postDryRunBatch, resolvePlanSha } from "./job.ts";
import type { DecomposerResult } from "./schemas.ts";
import { DecomposerResultSchema } from "./schemas.ts";

// ---- Constants ----

const testDir = import.meta.dirname;
if (!testDir) throw new Error("import.meta.dirname not available");

const REPO_ROOT = resolve(testDir, "../../../..");
const PLAN_PATH = "workspaces/fast-loop/jobs/decompose-plan/__fixtures__/trivial-plan.md";
const SESSION_ID = "e2e-test-session";
const WORKSPACE_ID = "test-workspace";
const FIXED_DATE = new Date("2026-04-15T18:00:00.000Z");

const VALID_BRIEF_TRACER = [
  "## Context",
  "Extend DecomposerResultSchema with metadata.",
  "",
  "## Acceptance Criteria",
  "- [ ] DecomposerResultSchema includes optional metadata field",
  "- [ ] JSON Schema in workspace.yml matches",
  "",
  "## Starting Points",
  "- workspaces/fast-loop/jobs/decompose-plan/schemas.ts",
].join("\n");

const VALID_BRIEF_WIRING = [
  "## Context",
  "Wire batch metadata into apply_to_backlog.",
  "",
  "## Acceptance Criteria",
  "- [ ] apply_to_backlog includes batch_metadata",
  "- [ ] integrity.ts validates created_at format",
  "",
  "## Starting Points",
  "- workspaces/fast-loop/jobs/decompose-plan/job.ts",
].join("\n");

function makeCannedBatch(): DecomposerResult {
  return {
    batch_id: "dp-canned-000000-000000",
    plan_ref: { path: PLAN_PATH, sha: "aaaaaa" },
    default_target: { workspace_id: "braised_biscuit", signal_id: "run-task" },
    tasks: [
      {
        task_id: "schema-extension",
        subject: "Tracer Bullet: Add metadata field to DecomposerResultSchema",
        task_brief: VALID_BRIEF_TRACER,
        target_files: ["workspaces/fast-loop/jobs/decompose-plan/schemas.ts"],
        blocked_by: [],
        priority: 10,
        is_tracer: true,
        plan_section: "Phase 1 § Schema Extension",
      },
      {
        task_id: "runtime-wiring",
        subject: "Wire batch metadata into apply_to_backlog",
        task_brief: VALID_BRIEF_WIRING,
        target_files: ["workspaces/fast-loop/jobs/decompose-plan/job.ts"],
        blocked_by: ["schema-extension"],
        priority: 20,
        is_tracer: false,
        plan_section: "Phase 2 § Runtime Wiring",
      },
    ],
  };
}

// ---- FSM Definition (mirrors workspace.yml decompose-plan-pipeline) ----

const NOOP_CODE = "export default function noop() {}";

const FSM_DEF: FSMDefinition = {
  id: "decompose-plan-pipeline",
  initial: "idle",
  states: {
    idle: { on: { "decompose-plan": { target: "prepare" } } },
    prepare: {
      entry: [
        { type: "code", function: "prepare_decompose" },
        { type: "emit", event: "ADVANCE" },
      ],
      on: { ADVANCE: { target: "decompose", guards: ["guard_prepare_done"] } },
    },
    decompose: {
      entry: [
        { type: "code", function: "prepare_agent_decompose" },
        {
          type: "agent",
          agentId: "plan-decomposer",
          outputTo: "decomposer-output",
          outputType: "decomposer-result",
        },
        { type: "emit", event: "ADVANCE" },
      ],
      on: { ADVANCE: { target: "integrity", guards: ["guard_decompose_done"] } },
    },
    integrity: {
      entry: [
        { type: "code", function: "integrity_check" },
        { type: "emit", event: "ADVANCE" },
      ],
      on: {
        ADVANCE: [
          { target: "apply", guards: ["guard_integrity_clean"] },
          { target: "retry_prepare", guards: ["guard_retry_allowed"] },
          { target: "diagnostic" },
        ],
      },
    },
    retry_prepare: {
      entry: [
        { type: "code", function: "retry_decompose" },
        { type: "emit", event: "ADVANCE" },
      ],
      on: { ADVANCE: { target: "decompose" } },
    },
    diagnostic: {
      entry: [
        { type: "code", function: "emit_diagnostic_task" },
        { type: "emit", event: "ADVANCE" },
      ],
      on: { ADVANCE: { target: "completed", guards: ["guard_diagnostic_done"] } },
    },
    apply: {
      entry: [
        { type: "code", function: "apply_to_backlog" },
        { type: "emit", event: "ADVANCE" },
      ],
      on: { ADVANCE: { target: "completed", guards: ["guard_apply_done"] } },
    },
    completed: { type: "final" },
  },
  functions: {
    prepare_decompose: { type: "action-io", code: NOOP_CODE },
    prepare_agent_decompose: { type: "action", code: NOOP_CODE },
    apply_to_backlog: { type: "action-io", code: NOOP_CODE },
    integrity_check: { type: "action-io", code: NOOP_CODE },
    retry_decompose: { type: "action", code: NOOP_CODE },
    emit_diagnostic_task: { type: "action-io", code: NOOP_CODE },
    guard_prepare_done: { type: "guard", code: NOOP_CODE },
    guard_decompose_done: { type: "guard", code: NOOP_CODE },
    guard_apply_done: { type: "guard", code: NOOP_CODE },
    guard_integrity_clean: { type: "guard", code: NOOP_CODE },
    guard_retry_allowed: { type: "guard", code: NOOP_CODE },
    guard_diagnostic_done: { type: "guard", code: NOOP_CODE },
  },
  documentTypes: { "decomposer-result": { type: "object" } },
};

// ---- TestCodeExecutor ----

class TestCodeExecutor implements CodeExecutor {
  constructor(private handlers: Record<string, (ctx: Context, sig: Signal) => unknown>) {}

  async execute(
    _functionCode: string,
    functionName: string,
    context: Context,
    signal: Signal,
  ): Promise<unknown> {
    const handler = this.handlers[functionName];
    if (!handler) throw new Error(`No test handler for: ${functionName}`);
    return await handler(context, signal);
  }
}

// ---- Zod schemas for safe extraction from fetch call bodies ----

const BacklogBodySchema = z.object({
  id: z.string(),
  text: z.string(),
  metadata: z.object({
    status: z.string(),
    priority: z.number(),
    kind: z.string(),
    blocked_by: z.array(z.string()),
    match_job_name: z.string(),
    auto_apply: z.boolean(),
    discovered_by: z.string(),
    discovered_session: z.string(),
    batch_id: z.string(),
    plan_ref: z.object({ path: z.string(), section: z.string().optional(), sha: z.string() }),
    payload: z.object({
      workspace_id: z.string(),
      signal_id: z.string(),
      task_id: z.string(),
      task_brief: z.string(),
      target_files: z.array(z.string()),
    }),
  }),
});

const DefaultTargetSchema = z.object({ workspace_id: z.string(), signal_id: z.string() });

// ---- Handler builders ----

function buildHandlers(): Record<string, (ctx: Context, sig: Signal) => unknown> {
  function requireSetResult(ctx: Context) {
    if (!ctx.setResult) throw new Error("setResult unavailable");
    return ctx.setResult;
  }

  return {
    // --- Actions ---

    prepare_decompose: async (ctx: Context, sig: Signal) => {
      const data = sig.data ?? {};
      const planPath = String(data.plan_path ?? "");
      const dt = DefaultTargetSchema.parse(data.default_target);
      const sha = await resolvePlanSha(planPath, REPO_ROOT);
      const batchId = buildBatchId(planPath, sha, FIXED_DATE);

      requireSetResult(ctx)("task-input", {
        plan_path: planPath,
        scope: data.scope ?? null,
        default_target: { workspace_id: dt.workspace_id, signal_id: dt.signal_id },
        dry_run: Boolean(data.dry_run),
        batch_id: batchId,
        plan_sha: sha,
        plan_ref: { path: planPath, sha },
      });
    },

    prepare_agent_decompose: (ctx: Context) => {
      const input = ctx.results["task-input"];
      if (!input) throw new Error("task-input not found");
      return {
        task: "Decompose plan at " + String(input.plan_path),
        config: {
          plan_path: input.plan_path,
          scope: input.scope ?? null,
          default_target: input.default_target,
          feedback: ctx.results["decomposer-feedback"] ?? null,
          is_retry: false,
        },
      };
    },

    integrity_check: (ctx: Context) => {
      const batch = DecomposerResultSchema.parse(ctx.results["decomposer-output"]);
      const findings = checkIntegrity(batch, REPO_ROOT);
      requireSetResult(ctx)("integrity-output", { findings, clean: findings.length === 0 });
    },

    apply_to_backlog: async (ctx: Context) => {
      const batch = DecomposerResultSchema.parse(ctx.results["decomposer-output"]);
      const input = ctx.results["task-input"];
      if (!input) throw new Error("task-input missing");
      const set = requireSetResult(ctx);

      const kernelBatchId = String(input.batch_id ?? batch.batch_id);
      const kernelSha = String(input.plan_sha ?? batch.plan_ref.sha);

      if (input.dry_run) {
        const dt = DefaultTargetSchema.parse(input.default_target);
        const dryResult = await postDryRunBatch(
          "http://localhost:8080/api/memory/salted_granola/narrative/dry-run-decompositions",
          batch,
          dt,
        );
        set("apply-output", {
          applied: dryResult.task_count,
          batch_id: kernelBatchId,
          task_ids: batch.tasks.map((t) => t.task_id),
          dry_run: true,
        });
        return;
      }

      const appliedTaskIds: string[] = [];
      for (const task of batch.tasks) {
        const body = {
          id: task.task_id,
          text: task.subject,
          metadata: {
            status: "pending",
            priority: task.priority,
            kind: task.is_tracer ? "tracer-bullet" : "decomposed-task",
            blocked_by: task.blocked_by,
            match_job_name: "execute-task",
            auto_apply: true,
            discovered_by: "decompose-plan",
            discovered_session: SESSION_ID,
            batch_id: kernelBatchId,
            plan_ref: { path: batch.plan_ref.path, section: task.plan_section, sha: kernelSha },
            payload: {
              workspace_id: task.target_workspace_id ?? batch.default_target.workspace_id,
              signal_id: task.target_signal_id ?? batch.default_target.signal_id,
              task_id: task.task_id,
              task_brief: task.task_brief,
              target_files: task.target_files,
            },
          },
        };
        const resp = await fetch(
          "http://localhost:8080/api/memory/salted_granola/narrative/autopilot-backlog",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`Failed to POST task ${task.task_id}: ${resp.status} ${errText}`);
        }
        appliedTaskIds.push(task.task_id);
      }

      set("apply-output", {
        applied: appliedTaskIds.length,
        batch_id: kernelBatchId,
        task_ids: appliedTaskIds,
        dry_run: false,
      });
    },

    retry_decompose: (ctx: Context) => {
      const current = ctx.results["retry-counter"];
      const count = current ? (Number(current.count) || 0) + 1 : 1;
      requireSetResult(ctx)("retry-counter", { count });
    },

    emit_diagnostic_task: (ctx: Context) => {
      requireSetResult(ctx)("diagnostic-output", {
        id: "diag-stub",
        createdAt: FIXED_DATE.toISOString(),
      });
    },

    // --- Guards ---

    guard_prepare_done: (ctx: Context) => ctx.results["task-input"] !== undefined,

    guard_decompose_done: (ctx: Context) => ctx.results["decomposer-output"] !== undefined,

    guard_apply_done: (ctx: Context) => ctx.results["apply-output"] !== undefined,

    guard_integrity_clean: (ctx: Context) => {
      const r = ctx.results["integrity-output"];
      return r !== undefined && r.clean === true;
    },

    guard_retry_allowed: (ctx: Context) => {
      const r = ctx.results["integrity-output"];
      if (!r || r.clean) return false;
      const counter = ctx.results["retry-counter"];
      const count = counter ? Number(counter.count) || 0 : 0;
      return count < 1;
    },

    guard_diagnostic_done: (ctx: Context) => ctx.results["diagnostic-output"] !== undefined,
  };
}

// ---- Tests ----

describe("decompose-plan E2E", () => {
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;
  let originalFetch: typeof globalThis.fetch;
  let computedBatchId: string;
  let computedSha: string;

  beforeEach(async () => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;

    globalThis.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation((input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body = z
          .record(z.string(), z.unknown())
          .parse(init?.body ? JSON.parse(String(init.body)) : {});
        fetchCalls.push({ url, body });
        return Promise.resolve(
          new Response(JSON.stringify({ id: "entry-1", createdAt: "2026-04-15T18:00:00.000Z" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });

    computedSha = await resolvePlanSha(PLAN_PATH, REPO_ROOT);
    computedBatchId = buildBatchId(PLAN_PATH, computedSha, FIXED_DATE);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function createEngine() {
    const store = new InMemoryDocumentStore();
    const scope = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };
    const cannedBatch = makeCannedBatch();

    const agentExecutor = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        agentId: "plan-decomposer",
        timestamp: FIXED_DATE.toISOString(),
        input: {},
        data: cannedBatch,
        durationMs: 100,
      }),
    );

    const engine = new FSMEngine(FSM_DEF, {
      documentStore: store,
      scope,
      codeExecutor: new TestCodeExecutor(buildHandlers()),
      agentExecutor,
    });
    await engine.initialize();

    return { engine, agentExecutor, cannedBatch };
  }

  it("happy path: signal → prepare → decompose → integrity → apply → completed", async () => {
    const { engine } = await createEngine();

    await engine.signal(
      {
        type: "decompose-plan",
        data: {
          plan_path: PLAN_PATH,
          default_target: { workspace_id: "braised_biscuit", signal_id: "run-task" },
        },
      },
      { sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, onEvent: () => {} },
    );

    expect(engine.state).toBe("completed");

    // Two POSTs to autopilot-backlog (one per task)
    const backlogCalls = fetchCalls.filter((c) => c.url.includes("/narrative/autopilot-backlog"));
    expect(backlogCalls).toHaveLength(2);

    const tracerEntry = BacklogBodySchema.parse(backlogCalls[0]?.body);
    const wiringEntry = BacklogBodySchema.parse(backlogCalls[1]?.body);

    // ---- Tracer task ----
    expect(tracerEntry.id).toBe("schema-extension");
    expect(tracerEntry.text).toBe("Tracer Bullet: Add metadata field to DecomposerResultSchema");
    expect(tracerEntry.metadata.kind).toBe("tracer-bullet");
    expect(tracerEntry.metadata.blocked_by).toEqual([]);
    expect(tracerEntry.metadata.priority).toBe(10);
    expect(tracerEntry.metadata.discovered_by).toBe("decompose-plan");
    expect(tracerEntry.metadata.discovered_session).toBe(SESSION_ID);
    expect(tracerEntry.metadata.match_job_name).toBe("execute-task");
    expect(tracerEntry.metadata.auto_apply).toBe(true);
    expect(tracerEntry.metadata.payload.workspace_id).toBe("braised_biscuit");
    expect(tracerEntry.metadata.payload.signal_id).toBe("run-task");
    expect(tracerEntry.metadata.payload.task_id).toBe("schema-extension");
    expect(tracerEntry.metadata.payload.target_files).toEqual([
      "workspaces/fast-loop/jobs/decompose-plan/schemas.ts",
    ]);

    // ---- Follow-up task ----
    expect(wiringEntry.id).toBe("runtime-wiring");
    expect(wiringEntry.metadata.kind).toBe("decomposed-task");
    expect(wiringEntry.metadata.blocked_by).toEqual(["schema-extension"]);
    expect(wiringEntry.metadata.priority).toBe(20);
    expect(wiringEntry.metadata.payload.task_id).toBe("runtime-wiring");

    // ---- batch_id propagation ----
    // Both entries share the same batch_id, computed by buildBatchId
    expect(tracerEntry.metadata.batch_id).toBe(computedBatchId);
    expect(wiringEntry.metadata.batch_id).toBe(computedBatchId);
    // Format: dp-<slug>-<YYYYMMDDHHMM>-<6-hex-sha>
    expect(computedBatchId).toMatch(/^dp-trivial-plan-\d{12}-[0-9a-f]{6}$/);

    // ---- plan_ref populated ----
    expect(tracerEntry.metadata.plan_ref).toEqual({
      path: PLAN_PATH,
      section: "Phase 1 § Schema Extension",
      sha: computedSha,
    });
    expect(wiringEntry.metadata.plan_ref).toEqual({
      path: PLAN_PATH,
      section: "Phase 2 § Runtime Wiring",
      sha: computedSha,
    });
    // SHA is consistent across both entries
    expect(tracerEntry.metadata.plan_ref.sha).toBe(wiringEntry.metadata.plan_ref.sha);
  });

  it("dry_run: routes to dry-run-decompositions instead of autopilot-backlog", async () => {
    const { engine, cannedBatch } = await createEngine();

    await engine.signal(
      {
        type: "decompose-plan",
        data: {
          plan_path: PLAN_PATH,
          default_target: { workspace_id: "braised_biscuit", signal_id: "run-task" },
          dry_run: true,
        },
      },
      { sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, onEvent: () => {} },
    );

    expect(engine.state).toBe("completed");

    // No POSTs to autopilot-backlog
    expect(fetchCalls.filter((c) => c.url.includes("/narrative/autopilot-backlog"))).toHaveLength(
      0,
    );

    // One POST to dry-run-decompositions
    const dryRunCalls = fetchCalls.filter((c) =>
      c.url.includes("/narrative/dry-run-decompositions"),
    );
    expect(dryRunCalls).toHaveLength(1);

    const DryRunBodySchema = z.object({
      text: z.string(),
      metadata: z.object({
        batch_id: z.string(),
        plan_ref: z.object({ path: z.string(), sha: z.string() }),
        default_target: z.object({ workspace_id: z.string(), signal_id: z.string() }),
        tasks: z.array(z.object({ task_id: z.string() })),
        expires_at: z.string(),
        created_at: z.string(),
      }),
    });

    const dryBody = DryRunBodySchema.parse(dryRunCalls[0]?.body);

    // Batch text and metadata reference the agent-produced batch
    expect(dryBody.text).toBe(cannedBatch.batch_id);
    expect(dryBody.metadata.batch_id).toBe(cannedBatch.batch_id);
    expect(dryBody.metadata.plan_ref.path).toBe(PLAN_PATH);
    expect(dryBody.metadata.default_target.workspace_id).toBe("braised_biscuit");

    // Both tasks present
    expect(dryBody.metadata.tasks).toHaveLength(2);
    expect(dryBody.metadata.tasks.map((t) => t.task_id)).toEqual([
      "schema-extension",
      "runtime-wiring",
    ]);

    // 24h expiry tag is a valid future ISO timestamp
    const expiresAt = new Date(dryBody.metadata.expires_at);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
