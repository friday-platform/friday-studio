/**
 * Tests for buildFSMDefinition — transforms FSM definitions into
 * flowchart TD Mermaid strings with action subgraphs and execution highlighting.
 *
 * @module
 */

import type { FSMDefinition } from "@atlas/fsm-engine";
import { describe, expect, it } from "vitest";
import { buildFSMDefinition } from "./fsm-definition-builder.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal FSM: idle → completed, no entry actions */
const minimalFSM: FSMDefinition = {
  id: "minimal",
  initial: "idle",
  states: { idle: { on: { ADVANCE: { target: "completed" } } }, completed: { type: "final" } },
};

/** FSM with entry actions on one state */
const fsmWithActions: FSMDefinition = {
  id: "with-actions",
  initial: "idle",
  states: {
    idle: { on: { START: { target: "analyze" } } },
    analyze: {
      entry: [
        { type: "agent", agentId: "prepare-agent" },
        { type: "llm", provider: "anthropic", model: "claude", prompt: "Analyze" },
        { type: "emit", event: "ADVANCE" },
      ],
      on: { ADVANCE: { target: "completed" } },
    },
    completed: { type: "final" },
  },
};

/** FSM with agent action */
const fsmWithAgentAction: FSMDefinition = {
  id: "with-agent",
  initial: "idle",
  states: {
    idle: { on: { GO: { target: "process" } } },
    process: {
      entry: [{ type: "agent", agentId: "data-analyst" }],
      on: { DONE: { target: "completed" } },
    },
    completed: { type: "final" },
  },
};

/** Single state FSM (no transitions besides final) */
const singleStateFSM: FSMDefinition = {
  id: "single",
  initial: "idle",
  states: { idle: { type: "final" } },
};

/** FSM with hyphenated state names (Mermaid compatibility) */
const hyphenatedFSM: FSMDefinition = {
  id: "hyphenated",
  initial: "step-one",
  states: { "step-one": { on: { NEXT: { target: "step-two" } } }, "step-two": { type: "final" } },
};

/** FSM with multiple transitions from the same state (array syntax) */
const multiTransitionFSM: FSMDefinition = {
  id: "multi-transition",
  initial: "idle",
  states: {
    idle: { on: { SUCCESS: { target: "done" }, FAIL: { target: "error" } } },
    done: { type: "final" },
    error: { type: "final" },
  },
};

// ---------------------------------------------------------------------------
// buildFSMDefinition — basic structure
// ---------------------------------------------------------------------------

describe("buildFSMDefinition", () => {
  describe("basic FSM (no actions)", () => {
    it("produces flowchart TD header", () => {
      const result = buildFSMDefinition(minimalFSM);
      expect(result).toMatch(/^flowchart TD\n/);
    });

    it("renders START and STOP nodes", () => {
      const result = buildFSMDefinition(minimalFSM);
      expect(result).toContain("START(( ))");
      expect(result).toContain("STOP(( ))");
    });

    it("renders initial state edge from START", () => {
      const result = buildFSMDefinition(minimalFSM);
      expect(result).toContain("START(( )) --> idle");
    });

    it("renders final state edge to STOP", () => {
      const result = buildFSMDefinition(minimalFSM);
      expect(result).toContain("completed --> STOP(( ))");
    });

    it("renders state nodes with labels", () => {
      const result = buildFSMDefinition(minimalFSM);
      expect(result).toContain('idle["idle"]');
      expect(result).toContain('completed["completed"]');
    });

    it("renders transition edges with signal labels", () => {
      const result = buildFSMDefinition(minimalFSM);
      expect(result).toContain('idle -->|"ADVANCE"| completed');
    });

    it("includes classDef declarations", () => {
      const result = buildFSMDefinition(minimalFSM);
      expect(result).toContain("classDef llmAction");
      expect(result).toContain("classDef agentAction");
      expect(result).toContain("classDef emitSignal");
      expect(result).toContain("classDef active");
      expect(result).toContain("classDef visited");
      expect(result).toContain("classDef unvisited");
    });
  });

  // ---------------------------------------------------------------------------
  // Entry actions as subgraphs
  // ---------------------------------------------------------------------------

  describe("entry actions", () => {
    it("renders action subgraph for states with entry actions", () => {
      const result = buildFSMDefinition(fsmWithActions);
      expect(result).toContain("subgraph analyze_actions");
      expect(result).toContain("direction TB");
    });

    it("renders agent action nodes with agentAction class (first entry)", () => {
      const result = buildFSMDefinition(fsmWithActions);
      expect(result).toMatch(/analyze_a0\["agent: prepare-agent"\]:::agentAction/);
    });

    it("renders llm action nodes with llmAction class", () => {
      const result = buildFSMDefinition(fsmWithActions);
      expect(result).toMatch(/analyze_a1\["AI: claude"\]:::llmAction/);
    });

    it("renders emit action nodes with emitSignal class", () => {
      const result = buildFSMDefinition(fsmWithActions);
      expect(result).toMatch(/analyze_a2\["emit ADVANCE"\]:::emitSignal/);
    });

    it("chains action nodes sequentially", () => {
      const result = buildFSMDefinition(fsmWithActions);
      expect(result).toContain("analyze_a0 --> analyze_a1 --> analyze_a2");
    });

    it("connects state to action subgraph with dotted edge", () => {
      const result = buildFSMDefinition(fsmWithActions);
      expect(result).toContain("analyze -.-> analyze_actions");
    });

    it("renders agent action nodes with agentAction class", () => {
      const result = buildFSMDefinition(fsmWithAgentAction);
      expect(result).toMatch(/process_a0\["agent: data-analyst"\]:::agentAction/);
    });

    it("does not render subgraph for states without entry actions", () => {
      const result = buildFSMDefinition(fsmWithActions);
      // idle has no entry actions, so no idle_actions subgraph
      expect(result).not.toContain("idle_actions");
    });
  });

  // ---------------------------------------------------------------------------
  // Execution state highlighting
  // ---------------------------------------------------------------------------

  describe("execution state highlighting", () => {
    it("applies active class to activeState", () => {
      const result = buildFSMDefinition(minimalFSM, { activeState: "idle" });
      expect(result).toContain("class idle active");
    });

    it("applies visited class to visitedStates", () => {
      const result = buildFSMDefinition(minimalFSM, {
        activeState: "completed",
        visitedStates: new Set(["idle", "completed"]),
      });
      expect(result).toContain("class idle visited");
      expect(result).toContain("class completed active");
    });

    it("applies unvisited class to remaining states", () => {
      const result = buildFSMDefinition(minimalFSM, {
        activeState: "idle",
        visitedStates: new Set(["idle"]),
      });
      expect(result).toContain("class completed unvisited");
    });

    it("does not apply execution classes when no options provided", () => {
      const result = buildFSMDefinition(minimalFSM);
      expect(result).not.toMatch(/class \w+ active/);
      expect(result).not.toMatch(/class \w+ visited/);
      expect(result).not.toMatch(/class \w+ unvisited/);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles single state FSM", () => {
      const result = buildFSMDefinition(singleStateFSM);
      expect(result).toContain("START(( )) --> idle");
      expect(result).toContain("idle --> STOP(( ))");
    });

    it("sanitizes hyphenated state names to underscores in node IDs", () => {
      const result = buildFSMDefinition(hyphenatedFSM);
      // Node IDs use underscores
      expect(result).toContain('step_one["step-one"]');
      expect(result).toContain('step_two["step-two"]');
      // Transition edges use sanitized IDs
      expect(result).toContain("step_one -->|");
    });

    it("handles multiple transitions from same state", () => {
      const result = buildFSMDefinition(multiTransitionFSM);
      expect(result).toContain('idle -->|"SUCCESS"| done');
      expect(result).toContain('idle -->|"FAIL"| error');
    });

    it("handles array-syntax transitions", () => {
      const fsm: FSMDefinition = {
        id: "array-transitions",
        initial: "idle",
        states: {
          idle: { on: { GO: [{ target: "a" }, { target: "b" }] } },
          a: { type: "final" },
          b: { type: "final" },
        },
      };
      const result = buildFSMDefinition(fsm);
      expect(result).toContain('idle -->|"GO"| a');
      expect(result).toContain('idle -->|"GO"| b');
    });

    it("guards against boolean `on` (YAML 1.1 coercion)", () => {
      const fsm: FSMDefinition = {
        id: "yaml-gotcha",
        initial: "idle",
        states: {
          idle: {
            // YAML 1.1 can coerce `on:` to boolean true
            on: true as unknown as Record<string, { target: string }>,
          },
        },
      };
      // Should not throw
      const result = buildFSMDefinition(fsm);
      expect(result).toContain("flowchart TD");
    });
  });
});
