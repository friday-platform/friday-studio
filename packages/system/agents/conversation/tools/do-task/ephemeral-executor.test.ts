/**
 * Tests for partial result preservation when a multi-step pipeline fails.
 *
 * When step N throws, the catch block should harvest committed results
 * from steps 0..N-1 via engine.results, not discard them.
 */

import type { AgentResult } from "@atlas/agent-sdk";
import type { DAGStep, DocumentContract, FSMDefinition } from "@atlas/workspace-builder";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { EnhancedTaskStep } from "./types.ts";

// ── Mocks ────────────────────────────────────────────────────────────────────

let mockExecuteAgent: Mock;

vi.mock("@atlas/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@atlas/core")>();
  return {
    ...original,
    AgentOrchestrator: class MockOrchestrator {
      executeAgent(...args: unknown[]) {
        return mockExecuteAgent(...args);
      }
      async shutdown() {}
    },
  };
});

vi.mock("@atlas/fsm-engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("@atlas/fsm-engine")>();
  return {
    ...original,
    expandArtifactRefsInDocuments: vi.fn().mockImplementation((docs: unknown[]) => docs),
    AtlasLLMProviderAdapter: class MockLLMProvider {},
  };
});

vi.mock("@atlas/hallucination", () => ({
  createFSMOutputValidator: vi.fn().mockReturnValue(() => ({ valid: true })),
  SupervisionLevel: { STANDARD: "standard" },
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeAgentResult(agentId: string, data: Record<string, unknown>): AgentResult {
  return {
    ok: true,
    agentId,
    timestamp: new Date().toISOString(),
    input: "test",
    data,
    durationMs: 50,
  };
}

function makeTwoStepFSM(): FSMDefinition {
  return {
    id: "test-two-step-pipeline",
    initial: "idle",
    states: {
      idle: { on: { "adhoc-trigger": { target: "step_agent_0" } } },
      step_agent_0: {
        entry: [
          { type: "agent", agentId: "agent-0", prompt: "Step 0", outputTo: "result_0" },
          { type: "emit", event: "ADVANCE" },
        ],
        on: { ADVANCE: { target: "step_agent_1" } },
      },
      step_agent_1: {
        entry: [
          { type: "agent", agentId: "agent-1", prompt: "Step 1", outputTo: "result_1" },
          { type: "emit", event: "ADVANCE" },
        ],
        on: { ADVANCE: { target: "completed" } },
      },
      completed: { type: "final" },
    },
  };
}

const twoStepDAG: DAGStep[] = [
  { id: "agent-0", agentId: "agent-0", description: "Step 0", depends_on: [] },
  { id: "agent-1", agentId: "agent-1", description: "Step 1", depends_on: ["agent-0"] },
];

const twoStepContracts: DocumentContract[] = [
  {
    producerStepId: "agent-0",
    documentId: "result_0",
    documentType: "result",
    schema: { type: "object" } as DocumentContract["schema"],
  },
  {
    producerStepId: "agent-1",
    documentId: "result_1",
    documentType: "result",
    schema: { type: "object" } as DocumentContract["schema"],
  },
];

const twoStepSteps: EnhancedTaskStep[] = [
  { agentId: "agent-0", description: "Step 0", executionType: "agent", capabilities: [] },
  { agentId: "agent-1", description: "Step 1", executionType: "agent", capabilities: [] },
];

const baseContext = {
  sessionId: "test-session",
  workspaceId: "test-workspace",
  streamId: "test-stream",
};

// ── Tests ────────────────────────────────────────────────────────────────────

// Lazy import — must be after vi.mock declarations
const { executeTaskViaFSMDirect } = await import("./ephemeral-executor.ts");

describe("executeTaskViaFSMDirect abort signal", () => {
  beforeEach(() => {
    mockExecuteAgent = vi.fn();
  });

  test("returns cancelled result when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await executeTaskViaFSMDirect(makeTwoStepFSM(), twoStepSteps, {
      ...baseContext,
      dagSteps: twoStepDAG,
      documentContracts: twoStepContracts,
      abortSignal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Task cancelled");
    expect(result.results).toHaveLength(0);
    expect(mockExecuteAgent).not.toHaveBeenCalled();
  });

  test("throws 'Task cancelled' when signal aborts mid-execution", async () => {
    const controller = new AbortController();

    // Step 0 succeeds, then abort before step 1
    mockExecuteAgent.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(makeAgentResult("agent-0", { done: true }));
    });

    const result = await executeTaskViaFSMDirect(makeTwoStepFSM(), twoStepSteps, {
      ...baseContext,
      dagSteps: twoStepDAG,
      documentContracts: twoStepContracts,
      abortSignal: controller.signal,
    });

    expect(result.success).toBe(false);
    // Step 1's agent executor checks abort signal and throws
    expect(result.results.some((r) => r.error?.includes("Task cancelled"))).toBe(true);
  });
});

describe("executeTaskViaFSMDirect partial results", () => {
  beforeEach(() => {
    mockExecuteAgent = vi.fn();
  });

  test("preserves step 0 result when step 1 throws", async () => {
    const step0Data = { issues: ["PROJ-1", "PROJ-2"], summary: "Found 2 issues" };

    mockExecuteAgent
      .mockResolvedValueOnce(makeAgentResult("agent-0", step0Data))
      .mockRejectedValueOnce(new Error("SMTP connection refused"));

    const result = await executeTaskViaFSMDirect(makeTwoStepFSM(), twoStepSteps, {
      ...baseContext,
      dagSteps: twoStepDAG,
      documentContracts: twoStepContracts,
    });

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe(1);
    expect(result.results).toHaveLength(2);

    // Step 0: successful with actual agent output data.
    // Flow: mockExecuteAgent returns AgentResult → FSM engine agent action handler
    // writes result.data to both engine.results[outputTo] and engine.documents[].
    // The catch block harvests from engine.results keyed by documentId (from contract).
    const step0 = result.results[0];
    expect(step0?.success).toBe(true);
    expect(step0?.step).toBe(0);
    expect(step0?.agent).toBe("agent-0");
    expect(step0?.output).toEqual(step0Data);

    // Step 1: failed with error
    const step1 = result.results[1];
    expect(step1?.success).toBe(false);
    expect(step1?.step).toBe(1);
    expect(step1?.agent).toBe("agent-1");
    expect(step1?.error).toContain("SMTP connection refused");
  });

  test("returns only the failed step when step 0 throws", async () => {
    mockExecuteAgent.mockRejectedValueOnce(new Error("MCP server unavailable"));

    const result = await executeTaskViaFSMDirect(makeTwoStepFSM(), twoStepSteps, {
      ...baseContext,
      dagSteps: twoStepDAG,
      documentContracts: twoStepContracts,
    });

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe(0);
    expect(result.results).toHaveLength(1);

    const step0 = result.results[0];
    expect(step0?.success).toBe(false);
    expect(step0?.step).toBe(0);
    expect(step0?.error).toContain("MCP server unavailable");
  });

  test("returns all results on success (baseline)", async () => {
    const step0Data = { issues: ["PROJ-1"] };
    const step1Data = { emailSent: true };

    mockExecuteAgent
      .mockResolvedValueOnce(makeAgentResult("agent-0", step0Data))
      .mockResolvedValueOnce(makeAgentResult("agent-1", step1Data));

    const result = await executeTaskViaFSMDirect(makeTwoStepFSM(), twoStepSteps, {
      ...baseContext,
      dagSteps: twoStepDAG,
      documentContracts: twoStepContracts,
    });

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.success).toBe(true);
    expect(result.results[1]?.success).toBe(true);
  });

  test("pushes failure result when documentContract is missing for a step", async () => {
    // When documentContracts omits step 1's contract, docId is undefined →
    // engineResults[undefined] misses → fallback document scan misses
    // (FSM stores under `outputTo` key, not agentId pattern) → branch 3
    // fires, pushing a failure result.
    //
    // Note: branch 2 (fallback document scan by agentId pattern) is unreachable
    // for agent actions because the FSM engine always dual-writes to both
    // engine.results[outputTo] and engine.documents[]. The fallback doc.id
    // pattern (`${agentId}_result` with hyphens replaced) never matches the
    // outputTo-keyed documents.
    const step0Data = { found: true };
    const step1Data = { sent: true };

    mockExecuteAgent
      .mockResolvedValueOnce(makeAgentResult("agent-0", step0Data))
      .mockResolvedValueOnce(makeAgentResult("agent-1", step1Data));

    // Only provide contract for step 0, omit step 1's contract
    const partialContracts: DocumentContract[] = [
      {
        producerStepId: "agent-0",
        documentId: "result_0",
        documentType: "result",
        schema: { type: "object" } as DocumentContract["schema"],
      },
    ];

    const result = await executeTaskViaFSMDirect(makeTwoStepFSM(), twoStepSteps, {
      ...baseContext,
      dagSteps: twoStepDAG,
      documentContracts: partialContracts,
    });

    // Step 0 succeeds via contract lookup
    expect(result.results[0]?.success).toBe(true);
    expect(result.results[0]?.output).toEqual(step0Data);

    // Step 1 has no contract → no docId → branch 3 fires
    const step1 = result.results[1];
    expect(step1?.success).toBe(false);
    expect(step1?.error).toBe("No result found for step");
  });
});
