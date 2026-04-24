/**
 * Tests for expandAgentActions — load-time transformation that converts
 * LLM workspace agents from `type: agent` to `type: llm` actions in FSM
 * definitions.
 */

import type { Action, FSMDefinition, StateDefinition } from "@atlas/fsm-engine";
import { describe, expect, it } from "vitest";
import type { WorkspaceAgentConfig } from "./agents.ts";
import { expandAgentActions } from "./expand-agent-actions.ts";
import { atlasAgent, llmAgent } from "./mutations/test-fixtures.ts";

// ==============================================================================
// HELPERS
// ==============================================================================

/** Minimal FSM definition with given states. */
function makeFSM(states: Record<string, StateDefinition>): FSMDefinition {
  return { id: "test-fsm", initial: "idle", states };
}

/** Extract entry array from a state in the result FSM, throwing if missing. */
function getEntry(result: FSMDefinition, stateId: string): Action[] {
  const state = result.states[stateId];
  if (!state?.entry) throw new Error(`Expected entry actions on state ${stateId}`);
  return state.entry;
}

// ==============================================================================
// TESTS
// ==============================================================================

describe("expandAgentActions", () => {
  it("expands LLM workspace agent to type: llm action", () => {
    const agents: Record<string, WorkspaceAgentConfig> = {
      "repo-cloner": llmAgent({
        prompt: "Clone repositories",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        tools: ["github"],
      }),
    };

    const fsm = makeFSM({
      idle: { on: { START: { target: "step_clone" } } },
      step_clone: {
        entry: [
          { type: "agent", agentId: "repo-cloner", prompt: "Clone the repo", outputTo: "result" },
          { type: "emit", event: "ADVANCE" },
        ],
        on: { ADVANCE: { target: "completed" } },
      },
      completed: { type: "final" },
    });

    const result = expandAgentActions(fsm, agents);

    const entry = getEntry(result, "step_clone");
    const [action, emitAction] = entry;

    expect(action).toEqual({
      type: "llm",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      prompt: "Clone repositories\n\nClone the repo",
      tools: ["github"],
      outputTo: "result",
    });

    // emit action untouched
    expect(emitAction).toEqual({ type: "emit", event: "ADVANCE" });
  });

  it("passes through atlas workspace agent unchanged", () => {
    const agents: Record<string, WorkspaceAgentConfig> = {
      "gh-agent": atlasAgent({ agent: "github" }),
    };

    const agentAction: Action = {
      type: "agent",
      agentId: "gh-agent",
      prompt: "Check PRs",
      outputTo: "result",
    };
    const fsm = makeFSM({
      idle: { on: { START: { target: "step_gh" } } },
      step_gh: { entry: [agentAction] },
      completed: { type: "final" },
    });

    const result = expandAgentActions(fsm, agents);
    const entry = getEntry(result, "step_gh");

    expect(entry[0]).toEqual(agentAction);
  });

  it("passes through unknown agentId unchanged (backward compat)", () => {
    const agents: Record<string, WorkspaceAgentConfig> = {};

    const agentAction: Action = {
      type: "agent",
      agentId: "claude-code",
      prompt: "Do something",
      outputTo: "result",
    };
    const fsm = makeFSM({
      idle: { on: { START: { target: "step_legacy" } } },
      step_legacy: { entry: [agentAction] },
      completed: { type: "final" },
    });

    const result = expandAgentActions(fsm, agents);
    const entry = getEntry(result, "step_legacy");

    expect(entry[0]).toEqual(agentAction);
  });

  it("only transforms agent actions in mixed entry arrays", () => {
    const agents: Record<string, WorkspaceAgentConfig> = {
      writer: llmAgent({ prompt: "Write content", tools: ["filesystem"] }),
    };

    const agentAction: Action = {
      type: "agent",
      agentId: "writer",
      prompt: "Write it",
      outputTo: "doc",
    };
    const emitAction: Action = { type: "emit", event: "DONE" };

    const fsm = makeFSM({
      idle: { on: { START: { target: "step_write" } } },
      step_write: { entry: [agentAction, emitAction] },
      completed: { type: "final" },
    });

    const result = expandAgentActions(fsm, agents);
    const entry = getEntry(result, "step_write");

    // agent action expanded to llm
    expect(entry[0]?.type).toBe("llm");
    // emit action untouched
    expect(entry[1]).toEqual(emitAction);
  });

  it("does not mutate the input FSM definition", () => {
    const agents: Record<string, WorkspaceAgentConfig> = {
      writer: llmAgent({ prompt: "Write content" }),
    };

    const fsm = makeFSM({
      idle: { on: { START: { target: "step_write" } } },
      step_write: { entry: [{ type: "agent", agentId: "writer", prompt: "Write it" }] },
      completed: { type: "final" },
    });

    const fsmSnapshot = JSON.stringify(fsm);
    expandAgentActions(fsm, agents);

    expect(JSON.stringify(fsm)).toBe(fsmSnapshot);
  });

  it("preserves outputType when expanding LLM agent", () => {
    const agents: Record<string, WorkspaceAgentConfig> = {
      analyzer: llmAgent({ prompt: "Analyze data" }),
    };

    const fsm = makeFSM({
      idle: { on: { START: { target: "step_analyze" } } },
      step_analyze: {
        entry: [
          {
            type: "agent",
            agentId: "analyzer",
            prompt: "Run analysis",
            outputTo: "result",
            outputType: "analysis-report",
          },
        ],
      },
      completed: { type: "final" },
    });

    const result = expandAgentActions(fsm, agents);
    const entry = getEntry(result, "step_analyze");
    const action = entry[0];

    expect(action?.type).toBe("llm");
    if (action?.type === "llm") {
      expect(action.outputType).toBe("analysis-report");
      expect(action.outputTo).toBe("result");
    }
  });

  it("combines agent config prompt with action prompt", () => {
    const agents: Record<string, WorkspaceAgentConfig> = {
      writer: llmAgent({ prompt: "You are a technical writer." }),
    };

    const fsm = makeFSM({
      idle: { on: { START: { target: "step_write" } } },
      step_write: { entry: [{ type: "agent", agentId: "writer", prompt: "Write the API docs" }] },
      completed: { type: "final" },
    });

    const result = expandAgentActions(fsm, agents);
    const entry = getEntry(result, "step_write");
    const action = entry[0];

    if (action?.type === "llm") {
      expect(action.prompt).toBe("You are a technical writer.\n\nWrite the API docs");
    } else {
      throw new Error("Expected LLM action");
    }
  });

  it("uses only config prompt when action has no prompt", () => {
    const agents: Record<string, WorkspaceAgentConfig> = {
      writer: llmAgent({ prompt: "You are a technical writer." }),
    };

    const fsm = makeFSM({
      idle: { on: { START: { target: "step_write" } } },
      step_write: { entry: [{ type: "agent", agentId: "writer" }] },
      completed: { type: "final" },
    });

    const result = expandAgentActions(fsm, agents);
    const entry = getEntry(result, "step_write");
    const action = entry[0];

    if (action?.type === "llm") {
      expect(action.prompt).toBe("You are a technical writer.");
    } else {
      throw new Error("Expected LLM action");
    }
  });

  it("handles states with no entry actions", () => {
    const agents: Record<string, WorkspaceAgentConfig> = {};

    const fsm = makeFSM({
      idle: { on: { START: { target: "completed" } } },
      completed: { type: "final" },
    });

    const result = expandAgentActions(fsm, agents);

    expect(result).toEqual(fsm);
  });
});
