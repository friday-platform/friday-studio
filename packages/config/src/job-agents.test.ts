/**
 * Tests for deriveJobAgents — extracts agent IDs used by a single job.
 */

import { describe, expect, test } from "vitest";
import { deriveJobAgents } from "./job-agents.ts";

describe("deriveJobAgents", () => {
  test("extracts agents from execution-based job with simple string IDs", () => {
    const agents = deriveJobAgents({
      execution: { strategy: "sequential", agents: ["gh", "claude-code"] },
    });

    expect(agents).toEqual(["gh", "claude-code"]);
  });

  test("extracts agents from execution-based job with detailed objects", () => {
    const agents = deriveJobAgents({
      execution: {
        strategy: "sequential",
        agents: [{ id: "gh" }, { id: "claude-code", nickname: "coder" }],
      },
    });

    expect(agents).toEqual(["gh", "claude-code"]);
  });

  test("handles mixed simple and detailed agent entries", () => {
    const agents = deriveJobAgents({
      execution: { strategy: "sequential", agents: ["gh", { id: "claude-code" }] },
    });

    expect(agents).toEqual(["gh", "claude-code"]);
  });

  test("extracts agents from FSM-based job", () => {
    const agents = deriveJobAgents({
      fsm: {
        id: "pr",
        initial: "idle",
        states: {
          idle: { on: { GO: { target: "step_clone" } } },
          step_clone: {
            entry: [{ type: "agent", agentId: "repo-cloner", prompt: "Clone" }],
            on: { NEXT: { target: "step_review" } },
          },
          step_review: {
            entry: [{ type: "agent", agentId: "code-reviewer", prompt: "Review" }],
            on: { NEXT: { target: "done" } },
          },
          done: { type: "final" },
        },
      },
    });

    expect(agents).toEqual(["repo-cloner", "code-reviewer"]);
  });

  test("deduplicates agents used in multiple FSM states", () => {
    const agents = deriveJobAgents({
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
    });

    expect(agents).toEqual(["worker"]);
  });

  test("returns empty array for job with no agents extractable", () => {
    const agents = deriveJobAgents({
      fsm: {
        id: "p",
        initial: "idle",
        states: { idle: { on: { GO: { target: "done" } } }, done: { type: "final" } },
      },
    });

    expect(agents).toEqual([]);
  });

  test("skips LLM actions in FSM, only returns agent actions", () => {
    const agents = deriveJobAgents({
      fsm: {
        id: "p",
        initial: "idle",
        states: {
          idle: { on: { GO: { target: "step_llm" } } },
          step_llm: {
            entry: [{ type: "llm", provider: "openai", model: "gpt-4", prompt: "Think" }],
            on: { NEXT: { target: "step_agent" } },
          },
          step_agent: {
            entry: [{ type: "agent", agentId: "summarizer", prompt: "Summarize" }],
            on: { NEXT: { target: "done" } },
          },
          done: { type: "final" },
        },
      },
    });

    expect(agents).toEqual(["summarizer"]);
  });
});
