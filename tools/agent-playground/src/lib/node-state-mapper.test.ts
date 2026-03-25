import { describe, expect, it } from "vitest";
import { deriveNodeStates, type NodeStateEntry, type NodeVisualState } from "./node-state-mapper.ts";
import type { Topology } from "@atlas/config";
import type { ActionEntry, ExecutionReport, StateTransition } from "./execution-context.svelte.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal three-step pipeline: signal -> step_a -> step_b -> completed */
function makeTopology(): Topology {
  return {
    nodes: [
      { id: "signal:trigger", type: "signal", label: "trigger", metadata: { provider: "http" } },
      { id: "job1:step_a", type: "agent-step", jobId: "job1", label: "step_a", metadata: {} },
      { id: "job1:step_b", type: "agent-step", jobId: "job1", label: "step_b", metadata: {} },
      { id: "job1:completed", type: "terminal", jobId: "job1", label: "completed", metadata: {} },
    ],
    edges: [
      { from: "signal:trigger", to: "job1:step_a" },
      { from: "job1:step_a", to: "job1:step_b" },
      { from: "job1:step_b", to: "job1:completed" },
    ],
  };
}

/** Builds a complete execution report for the three-step pipeline. */
function makeReport(overrides?: Partial<ExecutionReport>): ExecutionReport {
  return {
    success: true,
    finalState: "completed",
    stateTransitions: [
      { from: "idle", to: "step_a", signal: "trigger", timestamp: 1000 },
      { from: "step_a", to: "step_b", signal: "done", timestamp: 2000 },
      { from: "step_b", to: "completed", signal: "done", timestamp: 3000 },
    ],
    resultSnapshots: {},
    actionTrace: [
      { state: "step_a", actionType: "agent", status: "started" },
      { state: "step_a", actionType: "agent", status: "completed" },
      { state: "step_b", actionType: "agent", status: "started" },
      { state: "step_b", actionType: "agent", status: "completed" },
    ],
    assertions: [],
    durationMs: 2000,
    ...overrides,
  };
}

/** Helper to get the state string from a node state entry. */
function stateOf(map: Map<string, NodeStateEntry>, nodeId: string): NodeVisualState | undefined {
  return map.get(nodeId)?.state;
}

/** Shorthand: extract transitions and actionTrace from a report for deriveNodeStates. */
function derive(
  topology: Topology,
  report: ExecutionReport | null,
  timelineIndex: number,
  mockedStates?: Set<string>,
): Map<string, NodeStateEntry> {
  const transitions: StateTransition[] = report?.stateTransitions ?? [];
  const actionTrace: ActionEntry[] = report?.actionTrace ?? [];
  return deriveNodeStates(topology, transitions, actionTrace, timelineIndex, mockedStates);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deriveNodeStates", () => {
  describe("pre-run (no report)", () => {
    it("returns idle for every node when there is no execution report", () => {
      const topology = makeTopology();
      const result = derive(topology, null, -1);

      expect(result.size).toBe(topology.nodes.length);
      for (const node of topology.nodes) {
        expect(stateOf(result, node.id)).toBe("idle");
      }
    });

    it("includes no elapsed or error fields for idle nodes", () => {
      const topology = makeTopology();
      const result = derive(topology, null, -1);

      for (const entry of result.values()) {
        expect(entry.elapsed).toBeUndefined();
        expect(entry.error).toBeUndefined();
      }
    });
  });

  describe("during execution (partial report)", () => {
    it("marks completed steps as succeeded and current step as running", () => {
      const topology = makeTopology();
      // Only one transition so far: idle -> step_a (step_a is running)
      const report = makeReport({
        stateTransitions: [
          { from: "idle", to: "step_a", signal: "trigger", timestamp: 1000 },
        ],
        actionTrace: [
          { state: "step_a", actionType: "agent", status: "started" },
        ],
        finalState: "step_a",
        success: false,
      });

      // timelineIndex 0 = at the first transition (step_a entered)
      const result = derive(topology, report, 0);

      expect(stateOf(result, "job1:step_a")).toBe("running");
      expect(stateOf(result, "job1:step_b")).toBe("idle");
      expect(stateOf(result, "job1:completed")).toBe("idle");
    });

    it("marks step_a as succeeded when timeline advances past it", () => {
      const topology = makeTopology();
      const report = makeReport({
        stateTransitions: [
          { from: "idle", to: "step_a", signal: "trigger", timestamp: 1000 },
          { from: "step_a", to: "step_b", signal: "done", timestamp: 2000 },
        ],
        actionTrace: [
          { state: "step_a", actionType: "agent", status: "started" },
          { state: "step_a", actionType: "agent", status: "completed" },
          { state: "step_b", actionType: "agent", status: "started" },
        ],
        finalState: "step_b",
        success: false,
      });

      // timelineIndex 1 = at step_b entered
      const result = derive(topology, report, 1);

      expect(stateOf(result, "job1:step_a")).toBe("succeeded");
      expect(stateOf(result, "job1:step_b")).toBe("running");
      expect(stateOf(result, "job1:completed")).toBe("idle");
    });
  });

  describe("post-run with timeline scrubbing", () => {
    it("shows all final states when timeline is at the end", () => {
      const topology = makeTopology();
      const report = makeReport();

      // timelineIndex 2 = last transition (step_b -> completed)
      const result = derive(topology, report, 2);

      expect(stateOf(result, "job1:step_a")).toBe("succeeded");
      expect(stateOf(result, "job1:step_b")).toBe("succeeded");
      expect(stateOf(result, "job1:completed")).toBe("succeeded");
    });

    it("reverts nodes after playhead to idle when scrubbing backward", () => {
      const topology = makeTopology();
      const report = makeReport();

      // timelineIndex 0 = at step_a entered, step_b and completed should be idle
      // step_a shows its final state (succeeded) since the action completed
      const result = derive(topology, report, 0);

      expect(stateOf(result, "job1:step_a")).toBe("succeeded");
      expect(stateOf(result, "job1:step_b")).toBe("idle");
      expect(stateOf(result, "job1:completed")).toBe("idle");
    });

    it("returns all idle at timelineIndex -1 even with a report", () => {
      const topology = makeTopology();
      const report = makeReport();

      const result = derive(topology, report, -1);

      for (const node of topology.nodes) {
        expect(stateOf(result, node.id)).toBe("idle");
      }
    });
  });

  describe("failed state", () => {
    it("marks a step as failed when its action trace shows failure", () => {
      const topology = makeTopology();
      const report = makeReport({
        stateTransitions: [
          { from: "idle", to: "step_a", signal: "trigger", timestamp: 1000 },
          { from: "step_a", to: "step_b", signal: "done", timestamp: 2000 },
        ],
        actionTrace: [
          { state: "step_a", actionType: "agent", status: "started" },
          { state: "step_a", actionType: "agent", status: "completed" },
          { state: "step_b", actionType: "agent", status: "started" },
          { state: "step_b", actionType: "agent", status: "failed", error: "agent crashed" },
        ],
        finalState: "step_b",
        success: false,
        error: "agent crashed",
      });

      const result = derive(topology, report, 1);

      expect(stateOf(result, "job1:step_b")).toBe("failed");
      expect(result.get("job1:step_b")?.error).toBe("agent crashed");
    });
  });

  describe("mocked state", () => {
    it("marks steps as mocked when provided in mockedStates set", () => {
      const topology = makeTopology();
      const report = makeReport();

      const result = derive(topology, report, 2, new Set(["step_a", "step_b"]));

      expect(stateOf(result, "job1:step_a")).toBe("mocked");
      expect(stateOf(result, "job1:step_b")).toBe("mocked");
    });

    it("does not apply mocked to steps not in the set", () => {
      const topology = makeTopology();
      const report = makeReport();

      const result = derive(topology, report, 2, new Set(["step_a"]));

      expect(stateOf(result, "job1:step_a")).toBe("mocked");
      expect(stateOf(result, "job1:step_b")).toBe("succeeded");
    });

    it("does not mark idle nodes as mocked", () => {
      const topology = makeTopology();
      const report = makeReport({
        stateTransitions: [
          { from: "idle", to: "step_a", signal: "trigger", timestamp: 1000 },
        ],
        actionTrace: [
          { state: "step_a", actionType: "agent", status: "started" },
          { state: "step_a", actionType: "agent", status: "completed" },
        ],
        finalState: "step_a",
        success: false,
      });

      // step_b is not yet reached — should stay idle, not mocked
      const result = derive(topology, report, 0, new Set(["step_a", "step_b"]));

      expect(stateOf(result, "job1:step_a")).toBe("mocked");
      expect(stateOf(result, "job1:step_b")).toBe("idle");
    });
  });

  describe("elapsed time", () => {
    it("computes elapsed ms for succeeded steps from transition timestamps", () => {
      const topology = makeTopology();
      const report = makeReport();

      const result = derive(topology, report, 2);

      // step_a: entered at 1000, left at 2000 => 1000ms
      expect(result.get("job1:step_a")?.elapsed).toBe(1000);
      // step_b: entered at 2000, left at 3000 => 1000ms
      expect(result.get("job1:step_b")?.elapsed).toBe(1000);
    });

    it("computes elapsed for running step from entry timestamp to last known timestamp", () => {
      const topology = makeTopology();
      const report = makeReport({
        stateTransitions: [
          { from: "idle", to: "step_a", signal: "trigger", timestamp: 1000 },
          { from: "step_a", to: "step_b", signal: "done", timestamp: 2000 },
        ],
        finalState: "step_b",
        success: false,
      });

      // At timelineIndex 1, step_b is running. It entered at t=2000.
      // Last transition timestamp is 2000, so elapsed = 0
      const result = derive(topology, report, 1);
      expect(result.get("job1:step_b")?.elapsed).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("handles empty topology", () => {
      const topology: Topology = { nodes: [], edges: [] };
      const result = derive(topology, null, -1);
      expect(result.size).toBe(0);
    });

    it("handles topology with signal nodes only", () => {
      const topology: Topology = {
        nodes: [
          { id: "signal:trigger", type: "signal", label: "trigger", metadata: { provider: "http" } },
        ],
        edges: [],
      };
      const result = derive(topology, null, -1);
      expect(result.size).toBe(1);
      expect(stateOf(result, "signal:trigger")).toBe("idle");
    });

    it("handles timelineIndex beyond transition count by clamping", () => {
      const topology = makeTopology();
      const report = makeReport();

      // timelineIndex 99 is way past the 3 transitions
      const result = derive(topology, report, 99);

      // Should behave like timeline at end
      expect(stateOf(result, "job1:step_a")).toBe("succeeded");
      expect(stateOf(result, "job1:step_b")).toBe("succeeded");
      expect(stateOf(result, "job1:completed")).toBe("succeeded");
    });
  });
});
