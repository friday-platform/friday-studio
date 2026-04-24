/**
 * Tests for deriveTopology — pure workspace config → topology derivation
 */

import { describe, expect, test } from "vitest";
import { createTestConfig } from "./mutations/test-fixtures.ts";
import { deriveTopology } from "./topology.ts";

// ==============================================================================
// FIXTURES
// ==============================================================================

/** PR review exemplar: 3-step linear FSM with HTTP signal */
function prReviewConfig() {
  return createTestConfig({
    signals: {
      "review-pr": {
        provider: "http",
        description: "Accepts a GitHub PR URL",
        title: "Review a Pull Request",
        config: { path: "/webhooks/review-pr" },
      },
    },
    agents: {
      "repo-cloner": {
        type: "atlas",
        agent: "claude-code",
        description: "Clones the target repository",
        prompt: "You are Repo Cloner.",
      },
      "code-reviewer": {
        type: "atlas",
        agent: "claude-code",
        description: "Reviews the PR diff",
        prompt: "You are Code Reviewer.",
      },
      "review-reporter": {
        type: "atlas",
        agent: "claude-code",
        description: "Posts review comments",
        prompt: "You are Review Reporter.",
      },
    },
    jobs: {
      "pr-code-review": {
        title: "PR Code Review",
        description: "End-to-end PR code review",
        triggers: [{ signal: "review-pr" }],
        fsm: {
          id: "pr-code-review-pipeline",
          initial: "idle",
          states: {
            idle: { on: { "review-pr": { target: "step_clone_repo" } } },
            step_clone_repo: {
              entry: [
                {
                  type: "agent",
                  agentId: "claude-code",
                  outputTo: "clone-output",
                  prompt: "Clone the repo",
                },
                { type: "emit", event: "ADVANCE" },
              ],
              on: { ADVANCE: { target: "step_review_pr" } },
            },
            step_review_pr: {
              entry: [
                {
                  type: "agent",
                  agentId: "claude-code",
                  outputTo: "review-output",
                  prompt: "Review the PR",
                },
                { type: "emit", event: "ADVANCE" },
              ],
              on: { ADVANCE: { target: "step_post_review" } },
            },
            step_post_review: {
              entry: [
                {
                  type: "agent",
                  agentId: "claude-code",
                  outputTo: "post-review-output",
                  prompt: "Post review",
                },
                { type: "emit", event: "ADVANCE" },
              ],
              on: { ADVANCE: { target: "completed" } },
            },
            completed: { type: "final" },
          },
        },
      },
    },
  });
}

/** Multi-signal workspace: HTTP + schedule signals with separate jobs */
function multiSignalConfig() {
  return createTestConfig({
    signals: {
      webhook: { provider: "http", description: "HTTP webhook", config: { path: "/webhook" } },
      daily: {
        provider: "schedule",
        description: "Daily schedule",
        config: { schedule: "0 9 * * *" },
      },
    },
    jobs: {
      "webhook-job": {
        description: "Handles webhook",
        triggers: [{ signal: "webhook" }],
        fsm: {
          id: "webhook-fsm",
          initial: "start",
          states: {
            start: {
              entry: [
                {
                  type: "llm",
                  provider: "anthropic",
                  model: "claude-sonnet-4-6",
                  prompt: "Process webhook",
                },
              ],
              on: { DONE: { target: "end" } },
            },
            end: { type: "final" },
          },
        },
      },
      "daily-job": {
        description: "Handles daily cron",
        triggers: [{ signal: "daily" }],
        fsm: {
          id: "daily-fsm",
          initial: "start",
          states: {
            start: {
              entry: [{ type: "agent", agentId: "summarizer", prompt: "Summarize" }],
              on: { DONE: { target: "end" } },
            },
            end: { type: "final" },
          },
        },
      },
    },
  });
}

/** Branching FSM: a state with multiple transitions */
function branchingFSMConfig() {
  return createTestConfig({
    signals: {
      trigger: { provider: "http", description: "Trigger", config: { path: "/trigger" } },
    },
    jobs: {
      branching: {
        description: "Branching FSM",
        triggers: [{ signal: "trigger" }],
        fsm: {
          id: "branching-fsm",
          initial: "classify",
          states: {
            classify: {
              entry: [
                {
                  type: "llm",
                  provider: "anthropic",
                  model: "claude-sonnet-4-6",
                  prompt: "Classify input",
                },
              ],
              on: {
                POSITIVE: { target: "handle_positive" },
                NEGATIVE: { target: "handle_negative" },
              },
            },
            handle_positive: {
              entry: [{ type: "agent", agentId: "positive-handler", prompt: "Handle positive" }],
              on: { DONE: { target: "done" } },
            },
            handle_negative: {
              entry: [{ type: "agent", agentId: "negative-handler", prompt: "Handle negative" }],
              on: { DONE: { target: "done" } },
            },
            done: { type: "final" },
          },
        },
      },
    },
  });
}

/** Execution-mode-only workspace */
function executionModeConfig() {
  return createTestConfig({
    signals: {
      webhook: { provider: "http", description: "Webhook", config: { path: "/webhook" } },
    },
    jobs: {
      "exec-job": {
        description: "Execution mode job",
        triggers: [{ signal: "webhook" }],
        execution: { agents: ["agent-a", "agent-b"] },
      },
    },
  });
}

// ==============================================================================
// TESTS
// ==============================================================================

describe("deriveTopology", () => {
  test("returns empty topology for config with no jobs", () => {
    const config = createTestConfig();

    const result = deriveTopology(config);

    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  describe("PR review exemplar (3-step linear pipeline)", () => {
    test("produces signal node with HTTP type badge", () => {
      const config = prReviewConfig();

      const result = deriveTopology(config);

      const signalNodes = result.nodes.filter((n) => n.type === "signal");
      expect(signalNodes).toHaveLength(1);
      expect(signalNodes[0]).toMatchObject({
        type: "signal",
        label: "review-pr",
        metadata: expect.objectContaining({ provider: "http" }),
      });
    });

    test("produces agent-step nodes with agent metadata from extractFSMAgents", () => {
      const config = prReviewConfig();

      const result = deriveTopology(config);

      const agentNodes = result.nodes.filter((n) => n.type === "agent-step");
      // 4 non-final states: idle, step_clone_repo, step_review_pr, step_post_review
      expect(agentNodes).toHaveLength(4);

      // Each agent-step should have the job ID
      for (const node of agentNodes) {
        expect(node.jobId).toBe("pr-code-review");
      }

      // Agent steps with agent actions should have agent metadata
      const cloneStep = agentNodes.find((n) => n.id.includes("step_clone_repo"));
      expect(cloneStep).toBeDefined();
      expect(cloneStep?.metadata).toMatchObject({ type: "agent", agentId: "claude-code" });

      // Idle state has no agent metadata (no entry actions)
      const idleStep = agentNodes.find((n) => n.id.includes("idle"));
      expect(idleStep).toBeDefined();
      expect(idleStep?.metadata).toEqual({});
    });

    test("produces terminal node for final state", () => {
      const config = prReviewConfig();

      const result = deriveTopology(config);

      const terminalNodes = result.nodes.filter((n) => n.type === "terminal");
      expect(terminalNodes).toHaveLength(1);
      expect(terminalNodes[0]).toMatchObject({
        type: "terminal",
        label: "completed",
        jobId: "pr-code-review",
      });
    });

    test("produces edges connecting FSM states based on transition definitions", () => {
      const config = prReviewConfig();

      const result = deriveTopology(config);

      // Expect edges: idle->clone, clone->review, review->post, post->completed
      expect(result.edges.length).toBeGreaterThanOrEqual(4);

      // Check the linear chain exists
      const hasEdge = (fromSuffix: string, toSuffix: string) =>
        result.edges.some((e) => e.from.includes(fromSuffix) && e.to.includes(toSuffix));

      expect(hasEdge("idle", "step_clone_repo")).toBe(true);
      expect(hasEdge("step_clone_repo", "step_review_pr")).toBe(true);
      expect(hasEdge("step_review_pr", "step_post_review")).toBe(true);
      expect(hasEdge("step_post_review", "completed")).toBe(true);
    });

    test("edges include transition event name as label", () => {
      const config = prReviewConfig();

      const result = deriveTopology(config);

      const advanceEdge = result.edges.find(
        (e) => e.from.includes("step_clone_repo") && e.to.includes("step_review_pr"),
      );
      expect(advanceEdge).toBeDefined();
      expect(advanceEdge?.label).toBe("ADVANCE");
    });
  });

  describe("multi-signal workspace", () => {
    test("produces multiple signal entry point nodes", () => {
      const config = multiSignalConfig();

      const result = deriveTopology(config);

      const signalNodes = result.nodes.filter((n) => n.type === "signal");
      expect(signalNodes).toHaveLength(2);

      const providers = signalNodes.map((n) => n.metadata.provider);
      expect(providers).toContain("http");
      expect(providers).toContain("schedule");
    });

    test("produces labeled sections for multiple jobs", () => {
      const config = multiSignalConfig();

      const result = deriveTopology(config);

      const jobIds = new Set(result.nodes.filter((n) => n.jobId).map((n) => n.jobId));
      expect(jobIds.size).toBe(2);
      expect(jobIds).toContain("webhook-job");
      expect(jobIds).toContain("daily-job");
    });

    test("includes LLM agent metadata with provider and model", () => {
      const config = multiSignalConfig();

      const result = deriveTopology(config);

      const llmNode = result.nodes.find(
        (n) => n.type === "agent-step" && n.jobId === "webhook-job",
      );
      expect(llmNode).toBeDefined();
      expect(llmNode?.metadata).toMatchObject({
        type: "llm",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
    });
  });

  describe("branching FSM", () => {
    test("produces edges for each branch from branching state", () => {
      const config = branchingFSMConfig();

      const result = deriveTopology(config);

      const classifyEdges = result.edges.filter((e) => e.from.includes("classify"));
      expect(classifyEdges).toHaveLength(2);

      const targets = classifyEdges.map((e) => e.to);
      expect(targets.some((t) => t.includes("handle_positive"))).toBe(true);
      expect(targets.some((t) => t.includes("handle_negative"))).toBe(true);
    });

    test("branch edges carry event names as labels", () => {
      const config = branchingFSMConfig();

      const result = deriveTopology(config);

      const classifyEdges = result.edges.filter((e) => e.from.includes("classify"));
      const labels = classifyEdges.map((e) => e.label);
      expect(labels).toContain("POSITIVE");
      expect(labels).toContain("NEGATIVE");
    });

    test("multiple branches converge to single terminal", () => {
      const config = branchingFSMConfig();

      const result = deriveTopology(config);

      const terminalNodes = result.nodes.filter(
        (n) => n.type === "terminal" && n.jobId === "branching",
      );
      expect(terminalNodes).toHaveLength(1);

      // Both branches lead to done
      const toDone = result.edges.filter((e) => e.to.includes("done"));
      expect(toDone).toHaveLength(2);
    });
  });

  describe("execution-mode jobs", () => {
    test("excludes execution-mode jobs and flags them as unsupported", () => {
      const config = executionModeConfig();

      const result = deriveTopology(config);

      // No agent-step nodes since only job is execution mode
      const agentNodes = result.nodes.filter((n) => n.type === "agent-step");
      expect(agentNodes).toHaveLength(0);

      expect(result.unsupportedJobs).toContain("exec-job");
    });

    test("signal nodes still appear even when all jobs are execution-mode", () => {
      const config = executionModeConfig();

      const result = deriveTopology(config);

      const signalNodes = result.nodes.filter((n) => n.type === "signal");
      expect(signalNodes).toHaveLength(1);
    });
  });

  describe("mixed execution + FSM jobs", () => {
    test("only FSM job produces topology, execution job flagged unsupported", () => {
      const config = createTestConfig({
        signals: {
          webhook: { provider: "http", description: "Webhook", config: { path: "/webhook" } },
        },
        jobs: {
          "fsm-job": {
            description: "FSM job",
            triggers: [{ signal: "webhook" }],
            fsm: {
              id: "simple",
              initial: "start",
              states: {
                start: {
                  entry: [{ type: "agent", agentId: "worker", prompt: "Do work" }],
                  on: { DONE: { target: "end" } },
                },
                end: { type: "final" },
              },
            },
          },
          "exec-job": {
            description: "Execution job",
            triggers: [{ signal: "webhook" }],
            execution: { agents: ["agent-a"] },
          },
        },
      });

      const result = deriveTopology(config);

      const agentNodes = result.nodes.filter((n) => n.type === "agent-step");
      expect(agentNodes).toHaveLength(1);
      expect(agentNodes[0]?.jobId).toBe("fsm-job");

      expect(result.unsupportedJobs).toContain("exec-job");
      expect(result.unsupportedJobs).not.toContain("fsm-job");
    });
  });
});
