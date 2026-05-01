/**
 * Tests for mapSessionToStepStatus — maps session execution data onto
 * topology node IDs for pipeline status rendering.
 */

import type { AgentBlock, SessionSummary, SessionView } from "@atlas/core/session/session-events";
import { describe, expect, test } from "vitest";
import { mapSessionToStepStatus } from "./map-session-status.ts";
import type { Topology } from "./topology.ts";

// ==============================================================================
// FIXTURES
// ==============================================================================

/** 3-step linear pipeline topology (matches PR review exemplar) */
function prReviewTopology(): Topology {
  return {
    nodes: [
      { id: "signal:review-pr", type: "signal", label: "review-pr", metadata: {} },
      {
        id: "pr-code-review:step_clone_repo",
        type: "agent-step",
        jobId: "pr-code-review",
        label: "step_clone_repo",
        metadata: {},
      },
      {
        id: "pr-code-review:step_review_pr",
        type: "agent-step",
        jobId: "pr-code-review",
        label: "step_review_pr",
        metadata: {},
      },
      {
        id: "pr-code-review:step_post_review",
        type: "agent-step",
        jobId: "pr-code-review",
        label: "step_post_review",
        metadata: {},
      },
      {
        id: "pr-code-review:completed",
        type: "terminal",
        jobId: "pr-code-review",
        label: "completed",
        metadata: {},
      },
    ],
    edges: [
      { from: "pr-code-review:step_clone_repo", to: "pr-code-review:step_review_pr" },
      { from: "pr-code-review:step_review_pr", to: "pr-code-review:step_post_review" },
      { from: "pr-code-review:step_post_review", to: "pr-code-review:completed" },
    ],
  };
}

/** Creates an AgentBlock with sensible defaults */
function block(
  overrides: Partial<AgentBlock> & Pick<AgentBlock, "stateId" | "status">,
): AgentBlock {
  return {
    agentName: overrides.agentName ?? "test-agent",
    actionType: overrides.actionType ?? "agent",
    task: overrides.task ?? "Do something",
    toolCalls: overrides.toolCalls ?? [],
    output: overrides.output ?? null,
    ...overrides,
  };
}

/** Creates a SessionView with sensible defaults */
function sessionView(
  overrides: Partial<SessionView> & Pick<SessionView, "status" | "agentBlocks">,
): SessionView {
  return {
    sessionId: "sess-001",
    workspaceId: "ws-001",
    jobName: "pr-code-review",
    task: "Review PR #42",
    startedAt: "2026-03-13T10:00:00Z",
    ...overrides,
  };
}

// ==============================================================================
// TESTS
// ==============================================================================

describe("mapSessionToStepStatus", () => {
  describe("completed session", () => {
    test("maps all blocks to completed status", () => {
      const topology = prReviewTopology();
      const session = sessionView({
        status: "completed",
        completedAt: "2026-03-13T10:05:00Z",
        durationMs: 5000,
        agentBlocks: [
          block({ stateId: "step_clone_repo", status: "completed", stepNumber: 1 }),
          block({ stateId: "step_review_pr", status: "completed", stepNumber: 2 }),
          block({ stateId: "step_post_review", status: "completed", stepNumber: 3 }),
        ],
      });

      const result = mapSessionToStepStatus(session, topology);

      expect(result.get("pr-code-review:step_clone_repo")).toBe("completed");
      expect(result.get("pr-code-review:step_review_pr")).toBe("completed");
      expect(result.get("pr-code-review:step_post_review")).toBe("completed");
      expect(result.size).toBe(3);
    });
  });

  describe("failed session (mid-pipeline)", () => {
    test("maps blocks up to failure as completed, failing block as failed", () => {
      const topology = prReviewTopology();
      const session = sessionView({
        status: "failed",
        error: "Review failed",
        agentBlocks: [
          block({ stateId: "step_clone_repo", status: "completed", stepNumber: 1 }),
          block({ stateId: "step_review_pr", status: "failed", stepNumber: 2, error: "LLM error" }),
        ],
      });

      const result = mapSessionToStepStatus(session, topology);

      expect(result.get("pr-code-review:step_clone_repo")).toBe("completed");
      expect(result.get("pr-code-review:step_review_pr")).toBe("failed");
      // step_post_review never started — not in the map
      expect(result.has("pr-code-review:step_post_review")).toBe(false);
      expect(result.size).toBe(2);
    });
  });

  describe("active session", () => {
    test("maps completed blocks, running block as active", () => {
      const topology = prReviewTopology();
      const session = sessionView({
        status: "active",
        agentBlocks: [
          block({ stateId: "step_clone_repo", status: "completed", stepNumber: 1 }),
          block({ stateId: "step_review_pr", status: "running", stepNumber: 2 }),
        ],
      });

      const result = mapSessionToStepStatus(session, topology);

      expect(result.get("pr-code-review:step_clone_repo")).toBe("completed");
      expect(result.get("pr-code-review:step_review_pr")).toBe("active");
      // step_post_review not yet started — not in the map
      expect(result.has("pr-code-review:step_post_review")).toBe(false);
      expect(result.size).toBe(2);
    });

    test("maps first block as active when nothing completed yet", () => {
      const topology = prReviewTopology();
      const session = sessionView({
        status: "active",
        agentBlocks: [block({ stateId: "step_clone_repo", status: "running", stepNumber: 1 })],
      });

      const result = mapSessionToStepStatus(session, topology);

      expect(result.get("pr-code-review:step_clone_repo")).toBe("active");
      expect(result.size).toBe(1);
    });
  });

  describe("empty session", () => {
    test("returns empty map when session has no agent blocks", () => {
      const topology = prReviewTopology();
      const session = sessionView({ status: "active", agentBlocks: [] });

      const result = mapSessionToStepStatus(session, topology);

      expect(result.size).toBe(0);
    });

    test("returns empty map for SessionSummary (no agentBlocks field)", () => {
      const topology = prReviewTopology();
      const summary: SessionSummary = {
        sessionId: "sess-001",
        workspaceId: "ws-001",
        jobName: "pr-code-review",
        task: "Review PR #42",
        status: "completed",
        startedAt: "2026-03-13T10:00:00Z",
        stepCount: 3,
        agentNames: ["clone-agent", "review-agent", "post-agent"],
      };

      const result = mapSessionToStepStatus(summary, topology);

      expect(result.size).toBe(0);
    });
  });

  describe("edge cases", () => {
    test("skips blocks without stateId", () => {
      const topology = prReviewTopology();
      const session = sessionView({
        status: "completed",
        agentBlocks: [
          block({ stateId: "step_clone_repo", status: "completed", stepNumber: 1 }),
          block({ stateId: undefined, status: "completed", stepNumber: 2, agentName: "orphan" }),
          block({ stateId: "step_review_pr", status: "completed", stepNumber: 3 }),
        ],
      });

      const result = mapSessionToStepStatus(session, topology);

      expect(result.size).toBe(2);
      expect(result.get("pr-code-review:step_clone_repo")).toBe("completed");
      expect(result.get("pr-code-review:step_review_pr")).toBe("completed");
    });

    test("skips blocks whose stateId does not match any topology node", () => {
      const topology = prReviewTopology();
      const session = sessionView({
        status: "completed",
        agentBlocks: [
          block({ stateId: "step_clone_repo", status: "completed", stepNumber: 1 }),
          block({ stateId: "nonexistent_state", status: "completed", stepNumber: 2 }),
        ],
      });

      const result = mapSessionToStepStatus(session, topology);

      expect(result.size).toBe(1);
      expect(result.get("pr-code-review:step_clone_repo")).toBe("completed");
    });

    test("maps skipped blocks to skipped", () => {
      const topology = prReviewTopology();
      const session = sessionView({
        status: "completed",
        agentBlocks: [
          block({ stateId: "step_clone_repo", status: "completed", stepNumber: 1 }),
          block({ stateId: "step_review_pr", status: "skipped", stepNumber: 2 }),
          block({ stateId: "step_post_review", status: "completed", stepNumber: 3 }),
        ],
      });

      const result = mapSessionToStepStatus(session, topology);

      expect(result.get("pr-code-review:step_review_pr")).toBe("skipped");
    });

    test("maps pending blocks to pending", () => {
      const topology = prReviewTopology();
      const session = sessionView({
        status: "active",
        agentBlocks: [
          block({ stateId: "step_clone_repo", status: "completed", stepNumber: 1 }),
          block({ stateId: "step_review_pr", status: "running", stepNumber: 2 }),
          block({ stateId: "step_post_review", status: "pending", stepNumber: 3 }),
        ],
      });

      const result = mapSessionToStepStatus(session, topology);

      expect(result.get("pr-code-review:step_clone_repo")).toBe("completed");
      expect(result.get("pr-code-review:step_review_pr")).toBe("active");
      expect(result.get("pr-code-review:step_post_review")).toBe("pending");
    });
  });
});
