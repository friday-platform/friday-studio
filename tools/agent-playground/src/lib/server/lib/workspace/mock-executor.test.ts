import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentAction, Context, SignalWithContext } from "@atlas/fsm-engine";
import { WorkspaceBlueprintSchema } from "@atlas/workspace-builder";
import { describe, expect, it } from "vitest";
import { createMockAgentExecutor } from "./mock-executor.ts";

// ---------------------------------------------------------------------------
// Load plan from stable fixture (no run directory dependency)
// ---------------------------------------------------------------------------

if (!import.meta.dirname) throw new Error("import.meta.dirname unavailable");
const fixturePath = resolve(
  import.meta.dirname,
  "../../../../../../../packages/workspace-builder/fixtures/csv-analysis-plan.json",
);
const csvPlan = WorkspaceBlueprintSchema.parse(JSON.parse(readFileSync(fixturePath, "utf-8")));

// ---------------------------------------------------------------------------
// Minimal stubs for AgentExecutor args we don't care about in unit tests
// ---------------------------------------------------------------------------

const stubContext: Context = { documents: [], state: "step_analyze_csv", results: {} };

const stubSignal: SignalWithContext = { type: "csv-uploaded" };

// ---------------------------------------------------------------------------
// Override priority
// ---------------------------------------------------------------------------

describe("createMockAgentExecutor — override priority", () => {
  it("uses override data when action.outputTo matches a key", async () => {
    const overrideData = { summary: "overridden", queries: [] };
    const executor = createMockAgentExecutor({
      plan: csvPlan,
      agentOverrides: { "analysis-output": overrideData },
    });

    const action: AgentAction = {
      type: "agent",
      agentId: "data-analyst",
      outputTo: "analysis-output",
    };

    const result = await executor(action, stubContext, stubSignal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(overrideData);
    }
  });

  it("falls back to schema stub when no override matches", async () => {
    const executor = createMockAgentExecutor({ plan: csvPlan, agentOverrides: {} });

    const action: AgentAction = {
      type: "agent",
      agentId: "data-analyst",
      outputTo: "analysis-output",
    };

    const result = await executor(action, stubContext, stubSignal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Schema stub for analysis-output: { summary: "mock_summary", queries: [...] }
      expect(result.data).toMatchObject({ summary: "mock_summary", queries: expect.any(Array) });
    }
  });
});

// ---------------------------------------------------------------------------
// Schema-derived fallback
// ---------------------------------------------------------------------------

describe("createMockAgentExecutor — schema fallback", () => {
  it("generates stub from document contract schema", async () => {
    const executor = createMockAgentExecutor({ plan: csvPlan });

    const action: AgentAction = { type: "agent", agentId: "email", outputTo: "email-confirmation" };

    const result = await executor(action, stubContext, stubSignal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // email-confirmation has required: ["response"], optional: message_id
      expect(result.data).toMatchObject({ response: "mock_response" });
      expect(result.data).not.toHaveProperty("message_id");
    }
  });
});

// ---------------------------------------------------------------------------
// Missing contract → empty object
// ---------------------------------------------------------------------------

describe("createMockAgentExecutor — missing contract", () => {
  it("returns empty object when no contract exists for outputTo", async () => {
    const executor = createMockAgentExecutor({ plan: csvPlan });

    const action: AgentAction = {
      type: "agent",
      agentId: "unknown-agent",
      outputTo: "nonexistent-doc",
    };

    const result = await executor(action, stubContext, stubSignal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({});
    }
  });

  it("returns empty object when action has no outputTo", async () => {
    const executor = createMockAgentExecutor({ plan: csvPlan });

    const action: AgentAction = { type: "agent", agentId: "data-analyst" };

    const result = await executor(action, stubContext, stubSignal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// AgentResult envelope shape
// ---------------------------------------------------------------------------

describe("createMockAgentExecutor — result envelope", () => {
  it("returns a valid AgentExecutionSuccess envelope", async () => {
    const executor = createMockAgentExecutor({ plan: csvPlan });

    const action: AgentAction = {
      type: "agent",
      agentId: "data-analyst",
      outputTo: "analysis-output",
    };

    const result = await executor(action, stubContext, stubSignal);

    expect(result).toMatchObject({ ok: true, agentId: "data-analyst", input: {}, durationMs: 0 });
    expect(result).toHaveProperty("timestamp");
    if ("timestamp" in result) {
      expect(typeof result.timestamp).toBe("string");
    }
  });
});
