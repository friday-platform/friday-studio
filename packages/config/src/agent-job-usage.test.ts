/**
 * Tests for deriveAgentJobUsage — maps workspace agents to the
 * FSM steps that reference them.
 */

import { describe, expect, test } from "vitest";
import { deriveAgentJobUsage } from "./agent-job-usage.ts";
import { createTestConfig } from "./mutations/test-fixtures.ts";

describe("deriveAgentJobUsage", () => {
  test("maps 3 agents each to 1 step in PR review pipeline", () => {
    const config = createTestConfig({
      agents: {
        "repo-cloner": {
          type: "atlas",
          agent: "claude-code",
          description: "Cloner",
          prompt: "Clone repos",
        },
        "code-reviewer": {
          type: "atlas",
          agent: "claude-code",
          description: "Reviewer",
          prompt: "Review code",
        },
        "review-reporter": {
          type: "atlas",
          agent: "claude-code",
          description: "Reporter",
          prompt: "Report reviews",
        },
      },
      jobs: {
        "pr-code-review": {
          fsm: {
            id: "pr",
            initial: "idle",
            states: {
              idle: { on: { GO: { target: "step_clone_repo" } } },
              step_clone_repo: {
                entry: [{ type: "agent", agentId: "repo-cloner", prompt: "Clone" }],
                on: { NEXT: { target: "step_review_pr" } },
              },
              step_review_pr: {
                entry: [{ type: "agent", agentId: "code-reviewer", prompt: "Review" }],
                on: { NEXT: { target: "step_post_review" } },
              },
              step_post_review: {
                entry: [{ type: "agent", agentId: "review-reporter", prompt: "Post" }],
                on: { NEXT: { target: "done" } },
              },
              done: { type: "final" },
            },
          },
        },
      },
    });

    const usage = deriveAgentJobUsage(config);

    expect(usage.get("repo-cloner")).toEqual([
      { jobId: "pr-code-review", stepId: "step_clone_repo", stepName: "Clone Repo" },
    ]);
    expect(usage.get("code-reviewer")).toEqual([
      { jobId: "pr-code-review", stepId: "step_review_pr", stepName: "Review PR" },
    ]);
    expect(usage.get("review-reporter")).toEqual([
      { jobId: "pr-code-review", stepId: "step_post_review", stepName: "Post Review" },
    ]);
  });

  test("agent used in multiple steps within same job", () => {
    const config = createTestConfig({
      agents: {
        worker: { type: "atlas", agent: "claude-code", description: "Worker", prompt: "Do work" },
      },
      jobs: {
        pipeline: {
          fsm: {
            id: "p",
            initial: "idle",
            states: {
              idle: { on: { GO: { target: "step_one" } } },
              step_one: {
                entry: [{ type: "agent", agentId: "worker", prompt: "Do 1" }],
                on: { NEXT: { target: "step_two" } },
              },
              step_two: {
                entry: [{ type: "agent", agentId: "worker", prompt: "Do 2" }],
                on: { NEXT: { target: "done" } },
              },
              done: { type: "final" },
            },
          },
        },
      },
    });

    const usage = deriveAgentJobUsage(config);

    expect(usage.get("worker")).toEqual([
      { jobId: "pipeline", stepId: "step_one", stepName: "One" },
      { jobId: "pipeline", stepId: "step_two", stepName: "Two" },
    ]);
  });

  test("agent used across multiple jobs", () => {
    const config = createTestConfig({
      agents: {
        shared: {
          type: "atlas",
          agent: "claude-code",
          description: "Shared",
          prompt: "Shared work",
        },
      },
      jobs: {
        "job-a": {
          fsm: {
            id: "a",
            initial: "idle",
            states: {
              idle: { on: { GO: { target: "step_work" } } },
              step_work: {
                entry: [{ type: "agent", agentId: "shared", prompt: "Work A" }],
                on: { NEXT: { target: "done" } },
              },
              done: { type: "final" },
            },
          },
        },
        "job-b": {
          fsm: {
            id: "b",
            initial: "idle",
            states: {
              idle: { on: { GO: { target: "step_process" } } },
              step_process: {
                entry: [{ type: "agent", agentId: "shared", prompt: "Work B" }],
                on: { NEXT: { target: "done" } },
              },
              done: { type: "final" },
            },
          },
        },
      },
    });

    const usage = deriveAgentJobUsage(config);

    expect(usage.get("shared")).toEqual([
      { jobId: "job-a", stepId: "step_work", stepName: "Work" },
      { jobId: "job-b", stepId: "step_process", stepName: "Process" },
    ]);
  });

  test("agent not referenced by any step has empty array", () => {
    const config = createTestConfig({
      agents: {
        unused: { type: "atlas", agent: "claude-code", description: "Unused", prompt: "Unused" },
        active: { type: "atlas", agent: "claude-code", description: "Active", prompt: "Active" },
      },
      jobs: {
        pipeline: {
          fsm: {
            id: "p",
            initial: "idle",
            states: {
              idle: { on: { GO: { target: "step_work" } } },
              step_work: {
                entry: [{ type: "agent", agentId: "active", prompt: "Go" }],
                on: { NEXT: { target: "done" } },
              },
              done: { type: "final" },
            },
          },
        },
      },
    });

    const usage = deriveAgentJobUsage(config);

    expect(usage.get("unused")).toEqual([]);
    expect(usage.get("active")).toHaveLength(1);
  });

  test("returns empty map when no agents defined", () => {
    const config = createTestConfig({});

    const usage = deriveAgentJobUsage(config);

    expect(usage.size).toBe(0);
  });

  test("returns map with empty arrays when no jobs defined", () => {
    const config = createTestConfig({
      agents: {
        lonely: { type: "atlas", agent: "claude-code", description: "Lonely", prompt: "Lonely" },
      },
    });

    const usage = deriveAgentJobUsage(config);

    expect(usage.get("lonely")).toEqual([]);
  });
});
