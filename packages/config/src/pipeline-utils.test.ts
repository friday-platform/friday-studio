/**
 * Tests for pipeline data utilities — step name humanization and noise node filtering.
 */

import { describe, expect, test } from "vitest";
import { filterNoiseNodes, humanizeStepName } from "./pipeline-utils.ts";
import type { Topology, TopologyNode } from "./topology.ts";

// ==============================================================================
// humanizeStepName
// ==============================================================================

describe("humanizeStepName", () => {
  test("strips step_ prefix and title-cases", () => {
    expect(humanizeStepName("step_clone_repo")).toBe("Clone Repo");
  });

  test("handles multi-word step names", () => {
    expect(humanizeStepName("step_review_pr")).toBe("Review PR");
    expect(humanizeStepName("step_post_review")).toBe("Post Review");
  });

  test("handles state ID without step_ prefix", () => {
    expect(humanizeStepName("classify")).toBe("Classify");
    expect(humanizeStepName("handle_positive")).toBe("Handle Positive");
  });

  test("handles single word", () => {
    expect(humanizeStepName("idle")).toBe("Idle");
  });

  test("handles empty string", () => {
    expect(humanizeStepName("")).toBe("");
  });

  test("handles already readable text", () => {
    expect(humanizeStepName("step_a")).toBe("A");
  });

  test("uppercases known abbreviations", () => {
    expect(humanizeStepName("step_review_pr")).toBe("Review PR");
    expect(humanizeStepName("step_check_api")).toBe("Check API");
  });
});

// ==============================================================================
// filterNoiseNodes
// ==============================================================================

describe("filterNoiseNodes", () => {
  /** Builds a minimal topology for testing */
  function buildTopology(nodes: TopologyNode[]): Topology {
    return { nodes, edges: [] };
  }

  function agentNode(
    label: string,
    jobId: string,
    metadata: Record<string, unknown> = {},
  ): TopologyNode {
    return { id: `${jobId}:${label}`, type: "agent-step", jobId, label, metadata };
  }

  function terminalNode(label: string, jobId: string): TopologyNode {
    return { id: `${jobId}:${label}`, type: "terminal", jobId, label, metadata: {} };
  }

  function signalNode(label: string): TopologyNode {
    return { id: `signal:${label}`, type: "signal", label, metadata: { provider: "http" } };
  }

  test("removes terminal nodes", () => {
    const topology = buildTopology([
      signalNode("trigger"),
      agentNode("start", "job", { type: "agent" }),
      terminalNode("completed", "job"),
    ]);

    const result = filterNoiseNodes(topology, "start");

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.find((n) => n.type === "terminal")).toBeUndefined();
  });

  test("removes idle initial state with no agent/llm actions", () => {
    const topology = buildTopology([
      signalNode("trigger"),
      agentNode("idle", "job", {}), // no agent metadata
      agentNode("step_clone", "job", { type: "agent" }),
      terminalNode("completed", "job"),
    ]);

    const result = filterNoiseNodes(topology, "idle");

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.find((n) => n.label === "idle")).toBeUndefined();
    expect(result.nodes.find((n) => n.label === "step_clone")).toBeDefined();
  });

  test("keeps initial state that has agent/llm actions", () => {
    const topology = buildTopology([
      signalNode("trigger"),
      agentNode("classify", "job", { type: "llm" }),
      terminalNode("done", "job"),
    ]);

    const result = filterNoiseNodes(topology, "classify");

    // classify is initial but has agent metadata — keep it
    expect(result.nodes.find((n) => n.label === "classify")).toBeDefined();
  });

  test("preserves signal nodes", () => {
    const topology = buildTopology([
      signalNode("webhook"),
      agentNode("idle", "job", {}),
      agentNode("step_work", "job", { type: "agent" }),
      terminalNode("end", "job"),
    ]);

    const result = filterNoiseNodes(topology, "idle");

    expect(result.nodes.find((n) => n.type === "signal")).toBeDefined();
  });

  test("removes edges referencing filtered nodes", () => {
    const topology: Topology = {
      nodes: [
        signalNode("trigger"),
        agentNode("idle", "job", {}),
        agentNode("step_work", "job", { type: "agent" }),
        terminalNode("completed", "job"),
      ],
      edges: [
        { from: "job:idle", to: "job:step_work", label: "START" },
        { from: "job:step_work", to: "job:completed", label: "DONE" },
      ],
    };

    const result = filterNoiseNodes(topology, "idle");

    // idle and completed are removed, so both edges should be removed
    expect(result.edges).toHaveLength(0);
  });

  test("preserves edges between kept nodes", () => {
    const topology: Topology = {
      nodes: [
        agentNode("idle", "job", {}),
        agentNode("step_a", "job", { type: "agent" }),
        agentNode("step_b", "job", { type: "agent" }),
        terminalNode("done", "job"),
      ],
      edges: [
        { from: "job:idle", to: "job:step_a", label: "GO" },
        { from: "job:step_a", to: "job:step_b", label: "ADVANCE" },
        { from: "job:step_b", to: "job:done", label: "FINISH" },
      ],
    };

    const result = filterNoiseNodes(topology, "idle");

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ from: "job:step_a", to: "job:step_b" });
  });

  test("preserves unsupportedJobs", () => {
    const topology: Topology = {
      nodes: [terminalNode("end", "job")],
      edges: [],
      unsupportedJobs: ["exec-job"],
    };

    const result = filterNoiseNodes(topology, "start");

    expect(result.unsupportedJobs).toEqual(["exec-job"]);
  });
});
