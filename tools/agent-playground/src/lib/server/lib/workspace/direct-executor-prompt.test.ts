import type { AgentAction, Context } from "@atlas/fsm-engine";
import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "./direct-executor.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseAction: AgentAction = {
  type: "agent",
  agentId: "data-analyst",
  outputTo: "analysis-output",
};

const actionWithPrompt: AgentAction = { ...baseAction, prompt: "Analyze the CSV data" };

const contextWithDocs: Context = {
  documents: [{ type: "AgentResult", id: "foo_result", data: { key: "value" } }],
  state: "step_analyze",
  results: {},
};

const contextWithInput: Context = {
  documents: [{ type: "AgentResult", id: "foo_result", data: { key: "value" } }],
  state: "step_analyze",
  results: {},
  input: { task: "Analyze CSV", config: { format: "markdown" } },
};

const emptyContext: Context = { documents: [], state: "step_analyze", results: {} };

// ---------------------------------------------------------------------------
// Input section rendering
// ---------------------------------------------------------------------------

describe("buildAgentPrompt — input section", () => {
  it("includes Input section when fsmContext.input is present", () => {
    const prompt = buildAgentPrompt(baseAction, contextWithInput);

    expect(prompt).toContain("Input:\n");
    expect(prompt).toContain(JSON.stringify(contextWithInput.input, null, 2));
  });

  it("omits Input section when fsmContext.input is undefined", () => {
    const prompt = buildAgentPrompt(baseAction, contextWithDocs);

    expect(prompt).not.toContain("Input:");
  });

  it("no Documents section even when documents exist", () => {
    const prompt = buildAgentPrompt(baseAction, contextWithInput);

    expect(prompt).toContain("Input:\n");
    expect(prompt).not.toContain("Documents:");
  });
});

// ---------------------------------------------------------------------------
// Documents-only (pre-existing behavior preserved)
// ---------------------------------------------------------------------------

describe("buildAgentPrompt — no documents section", () => {
  it("never includes Documents section even with documents", () => {
    const prompt = buildAgentPrompt(baseAction, contextWithDocs);

    expect(prompt).not.toContain("Documents:");
  });

  it("uses action.prompt when provided", () => {
    const prompt = buildAgentPrompt(actionWithPrompt, contextWithDocs);

    expect(prompt).toMatch(/^Analyze the CSV data/);
  });

  it("uses default prompt when action.prompt is absent", () => {
    const prompt = buildAgentPrompt(baseAction, contextWithDocs);

    expect(prompt).toMatch(/^Execute task step for agent "data-analyst"/);
  });

  it("handles empty documents and no input — just the prompt", () => {
    const prompt = buildAgentPrompt(baseAction, emptyContext);

    expect(prompt).not.toContain("Documents:");
    expect(prompt).not.toContain("Input:");
  });
});
