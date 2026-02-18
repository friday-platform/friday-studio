/**
 * Tests for FSM agent extraction and mutation functions
 */

import { describe, expect, test } from "vitest";
import { extractFSMAgents, updateFSMAgent } from "./fsm-agents.ts";
import { createTestConfig, expectError } from "./test-fixtures.ts";

/**
 * Create an FSM job config with agent/llm actions in state entries.
 */
function createFSMJob(
  entries: Array<
    | { type: "agent"; agentId: string; prompt?: string }
    | { type: "llm"; provider: string; model: string; prompt: string }
    | { type: "code"; function: string }
  >,
) {
  return {
    description: "Test FSM job",
    triggers: [{ signal: "webhook" }],
    fsm: {
      id: "test-fsm",
      initial: "step_0",
      states: {
        step_0: { entry: entries, on: { DONE: { target: "complete" } } },
        complete: { type: "final" as const },
      },
    },
  };
}

describe("extractFSMAgents", () => {
  test("returns empty object for empty config", () => {
    const config = createTestConfig();

    const result = extractFSMAgents(config);

    expect(result).toEqual({});
  });

  test("returns empty object when no jobs present", () => {
    const config = createTestConfig({ jobs: {} });

    const result = extractFSMAgents(config);

    expect(result).toEqual({});
  });

  test("returns empty object for non-FSM jobs", () => {
    const config = createTestConfig({
      jobs: {
        "simple-job": {
          description: "Non-FSM job with execution block",
          triggers: [{ signal: "webhook" }],
          execution: { strategy: "sequential", agents: ["my-agent"] },
        },
      },
    });

    const result = extractFSMAgents(config);

    expect(result).toEqual({});
  });

  test("extracts agent action from FSM state", () => {
    const config = createTestConfig({
      jobs: {
        "research-job": createFSMJob([
          { type: "code", function: "prepare" },
          { type: "agent", agentId: "research", prompt: "Do research" },
        ]),
      },
    });

    const result = extractFSMAgents(config);

    expect(result).toMatchObject({
      "research-job:step_0": {
        id: "research-job:step_0",
        jobId: "research-job",
        stateId: "step_0",
        entryIndex: 1,
        type: "agent",
        agentId: "research",
        prompt: "Do research",
      },
    });
  });

  test("extracts llm action from FSM state", () => {
    const config = createTestConfig({
      jobs: {
        "summarize-job": createFSMJob([
          {
            type: "llm",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            prompt: "Summarize this",
          },
        ]),
      },
    });

    const result = extractFSMAgents(config);

    expect(result).toMatchObject({
      "summarize-job:step_0": {
        id: "summarize-job:step_0",
        jobId: "summarize-job",
        stateId: "step_0",
        entryIndex: 0,
        type: "llm",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        prompt: "Summarize this",
      },
    });
  });

  test("extracts llm action with all optional fields", () => {
    const config = createTestConfig({
      jobs: {
        "full-llm-job": {
          description: "Job with full LLM config",
          triggers: [{ signal: "webhook" }],
          fsm: {
            id: "full-llm-fsm",
            initial: "step_0",
            states: {
              step_0: {
                entry: [
                  {
                    type: "llm",
                    provider: "anthropic",
                    model: "claude-sonnet-4-6",
                    prompt: "Process data",
                    tools: ["linear", "notion"],
                    outputTo: "result_doc",
                    outputType: "ProcessResult",
                  },
                ],
                on: { DONE: { target: "complete" } },
              },
              complete: { type: "final" as const },
            },
          },
        },
      },
    });

    const result = extractFSMAgents(config);

    expect(result).toMatchObject({
      "full-llm-job:step_0": {
        type: "llm",
        tools: ["linear", "notion"],
        outputTo: "result_doc",
        outputType: "ProcessResult",
      },
    });
  });

  test("extracts agents from multiple states in one job", () => {
    const config = createTestConfig({
      jobs: {
        "multi-step-job": {
          description: "Job with multiple steps",
          triggers: [{ signal: "webhook" }],
          fsm: {
            id: "multi-step-fsm",
            initial: "step_0",
            states: {
              step_0: {
                entry: [
                  {
                    type: "llm",
                    provider: "anthropic",
                    model: "claude-sonnet-4-6",
                    prompt: "Step 1",
                  },
                ],
                on: { ADVANCE: { target: "step_1" } },
              },
              step_1: {
                entry: [{ type: "agent", agentId: "processor" }],
                on: { ADVANCE: { target: "complete" } },
              },
              complete: { type: "final" as const },
            },
          },
        },
      },
    });

    const result = extractFSMAgents(config);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result["multi-step-job:step_0"]).toMatchObject({ type: "llm", stateId: "step_0" });
    expect(result["multi-step-job:step_1"]).toMatchObject({ type: "agent", stateId: "step_1" });
  });

  test("extracts agents from multiple jobs", () => {
    const config = createTestConfig({
      jobs: {
        "job-a": createFSMJob([{ type: "agent", agentId: "agent-a" }]),
        "job-b": createFSMJob([
          { type: "llm", provider: "anthropic", model: "claude-sonnet-4-6", prompt: "Task B" },
        ]),
      },
    });

    const result = extractFSMAgents(config);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result["job-a:step_0"]).toMatchObject({ jobId: "job-a", type: "agent" });
    expect(result["job-b:step_0"]).toMatchObject({ jobId: "job-b", type: "llm" });
  });

  test("path format is jobId:stateId", () => {
    const config = createTestConfig({
      jobs: {
        "my-job-name": {
          description: "Test job",
          triggers: [{ signal: "webhook" }],
          fsm: {
            id: "test-fsm",
            initial: "my_state_name",
            states: {
              my_state_name: {
                entry: [{ type: "agent", agentId: "test" }],
                on: { DONE: { target: "complete" } },
              },
              complete: { type: "final" as const },
            },
          },
        },
      },
    });

    const result = extractFSMAgents(config);

    expect(result).toHaveProperty("my-job-name:my_state_name");
    expect(result["my-job-name:my_state_name"]).toMatchObject({
      id: "my-job-name:my_state_name",
      jobId: "my-job-name",
      stateId: "my_state_name",
    });
  });

  test("takes only first agent/llm action per state", () => {
    const config = createTestConfig({
      jobs: {
        "multi-action-job": {
          description: "Job with multiple agent actions in one state",
          triggers: [{ signal: "webhook" }],
          fsm: {
            id: "multi-action-fsm",
            initial: "step_0",
            states: {
              step_0: {
                entry: [
                  { type: "agent", agentId: "first-agent", prompt: "First" },
                  {
                    type: "llm",
                    provider: "anthropic",
                    model: "claude-sonnet-4-6",
                    prompt: "Second",
                  },
                ],
                on: { DONE: { target: "complete" } },
              },
              complete: { type: "final" as const },
            },
          },
        },
      },
    });

    const result = extractFSMAgents(config);

    // Should only have one entry for step_0, the first agent action
    expect(Object.keys(result)).toHaveLength(1);
    expect(result["multi-action-job:step_0"]).toMatchObject({
      type: "agent",
      agentId: "first-agent",
      prompt: "First",
    });
  });

  test("skips states without entry arrays", () => {
    const config = createTestConfig({
      jobs: {
        "partial-job": {
          description: "Job with state missing entry",
          triggers: [{ signal: "webhook" }],
          fsm: {
            id: "partial-fsm",
            initial: "step_0",
            states: {
              step_0: {
                entry: [{ type: "agent", agentId: "test" }],
                on: { DONE: { target: "complete" } },
              },
              complete: { type: "final" as const },
              // final states don't have entry arrays
            },
          },
        },
      },
    });

    const result = extractFSMAgents(config);

    expect(Object.keys(result)).toHaveLength(1);
    expect(result).toHaveProperty("partial-job:step_0");
    expect(result).not.toHaveProperty("partial-job:complete");
  });

  test("skips states with only code/emit actions", () => {
    const config = createTestConfig({
      jobs: {
        "code-only-job": createFSMJob([
          { type: "code", function: "setup" },
          { type: "code", function: "process" },
        ]),
      },
    });

    const result = extractFSMAgents(config);

    expect(result).toEqual({});
  });

  test("skips jobs that fail FSM schema validation", () => {
    const config = createTestConfig({
      jobs: {
        "valid-job": createFSMJob([{ type: "agent", agentId: "valid" }]),
        "invalid-fsm-job": {
          description: "Job with invalid FSM",
          triggers: [{ signal: "webhook" }],
          // Missing required 'id' field - fails FSMDefinitionSchema.safeParse()
          fsm: {
            initial: "step_0",
            states: {
              step_0: {
                entry: [{ type: "agent", agentId: "should-be-skipped" }],
                on: { DONE: { target: "complete" } },
              },
              complete: { type: "final" },
            },
          },
        },
      },
    });

    const result = extractFSMAgents(config);

    // Only valid-job should appear
    expect(Object.keys(result)).toHaveLength(1);
    expect(result).toHaveProperty("valid-job:step_0");
    expect(result).not.toHaveProperty("invalid-fsm-job:step_0");
  });

  test("includes agent outputTo field when present", () => {
    const config = createTestConfig({
      jobs: {
        "agent-output-job": {
          description: "Agent with outputTo",
          triggers: [{ signal: "webhook" }],
          fsm: {
            id: "agent-output-fsm",
            initial: "step_0",
            states: {
              step_0: {
                entry: [{ type: "agent", agentId: "research", outputTo: "research_result" }],
                on: { DONE: { target: "complete" } },
              },
              complete: { type: "final" as const },
            },
          },
        },
      },
    });

    const result = extractFSMAgents(config);

    expect(result["agent-output-job:step_0"]).toMatchObject({
      type: "agent",
      outputTo: "research_result",
    });
  });
});

describe("updateFSMAgent", () => {
  describe("error cases", () => {
    test("returns validation error for invalid path format", () => {
      const config = createTestConfig({ jobs: { "my-job": createFSMJob([]) } });

      const result = updateFSMAgent(config, "invalid-format", { type: "agent" });

      expectError(result, "validation", (e) => {
        expect(e.message).toContain("Invalid agent path ID format");
      });
    });

    test("returns validation error for path with too many parts", () => {
      const config = createTestConfig({ jobs: { "my-job": createFSMJob([]) } });

      const result = updateFSMAgent(config, "my-job:step_0:extra", { type: "agent" });

      expectError(result, "validation", (e) => {
        expect(e.message).toContain("Invalid agent path ID format");
      });
    });

    test("returns not_found when job does not exist", () => {
      const config = createTestConfig({ jobs: {} });

      const result = updateFSMAgent(config, "nonexistent:state", { type: "agent" });

      expectError(result, "not_found", (e) => {
        expect(e.entityId).toBe("nonexistent:state");
        expect(e.entityType).toBe("agent");
      });
    });

    test("returns not_found when job has no FSM", () => {
      const config = createTestConfig({
        jobs: {
          "simple-job": {
            description: "Non-FSM job",
            triggers: [{ signal: "webhook" }],
            execution: { strategy: "sequential", agents: ["agent"] },
          },
        },
      });

      const result = updateFSMAgent(config, "simple-job:state", { type: "agent" });

      expectError(result, "not_found");
    });

    test("returns not_found when job has malformed FSM", () => {
      const config = createTestConfig({
        jobs: {
          "bad-fsm-job": {
            description: "Job with invalid FSM structure",
            triggers: [{ signal: "webhook" }],
            // FSM exists but fails FSMDefinitionSchema.safeParse() - missing required 'id' field
            fsm: {
              initial: "step_0",
              states: {
                step_0: {
                  entry: [{ type: "agent", agentId: "test" }],
                  on: { DONE: { target: "complete" } },
                },
                complete: { type: "final" },
              },
            },
          },
        },
      });

      const result = updateFSMAgent(config, "bad-fsm-job:step_0", { type: "agent" });

      expectError(result, "not_found", (e) => {
        expect(e.entityId).toBe("bad-fsm-job:step_0");
        expect(e.entityType).toBe("agent");
      });
    });

    test("returns not_found when state does not exist", () => {
      const config = createTestConfig({
        jobs: { "my-job": createFSMJob([{ type: "agent", agentId: "test" }]) },
      });

      const result = updateFSMAgent(config, "my-job:nonexistent", { type: "agent" });

      expectError(result, "not_found");
    });

    test("returns not_found when state has no agent/llm action", () => {
      const config = createTestConfig({
        jobs: {
          "my-job": {
            description: "Job with code-only state",
            triggers: [{ signal: "webhook" }],
            fsm: {
              id: "test",
              initial: "step_0",
              states: {
                step_0: {
                  entry: [{ type: "code", function: "() => {}" }],
                  on: { DONE: { target: "complete" } },
                },
                complete: { type: "final" },
              },
            },
          },
        },
      });

      const result = updateFSMAgent(config, "my-job:step_0", { type: "agent" });

      expectError(result, "not_found");
    });

    test("returns invalid_operation when changing agent type", () => {
      const config = createTestConfig({
        jobs: {
          "my-job": createFSMJob([
            { type: "llm", provider: "anthropic", model: "claude-sonnet-4-6", prompt: "Test" },
          ]),
        },
      });

      const result = updateFSMAgent(config, "my-job:step_0", { type: "agent", prompt: "Changed" });

      expectError(result, "invalid_operation", (e) => {
        expect(e.message).toContain("Cannot change action type");
        expect(e.message).toContain("llm");
        expect(e.message).toContain("agent");
      });
    });
  });

  describe("bundled agent updates (type: agent)", () => {
    test("updates prompt for bundled agent", () => {
      const config = createTestConfig({
        jobs: {
          "my-job": createFSMJob([{ type: "agent", agentId: "research", prompt: "Original" }]),
        },
      });

      const result = updateFSMAgent(config, "my-job:step_0", {
        type: "agent",
        prompt: "Updated prompt",
      });

      expect(result.ok).toBe(true);
      expect(result).toHaveProperty(
        "value.jobs.my-job.fsm.states.step_0.entry.0.prompt",
        "Updated prompt",
      );
    });

    test("preserves other fields when updating prompt", () => {
      const config = createTestConfig({
        jobs: {
          "my-job": createFSMJob([{ type: "agent", agentId: "research", prompt: "Original" }]),
        },
      });

      const result = updateFSMAgent(config, "my-job:step_0", { type: "agent", prompt: "Updated" });

      expect(result.ok).toBe(true);
      expect(result).toHaveProperty(
        "value.jobs.my-job.fsm.states.step_0.entry.0",
        expect.objectContaining({ type: "agent", agentId: "research" }),
      );
    });

    test("no-op when update has no fields", () => {
      const config = createTestConfig({
        jobs: {
          "my-job": createFSMJob([{ type: "agent", agentId: "research", prompt: "Keep this" }]),
        },
      });

      const result = updateFSMAgent(config, "my-job:step_0", { type: "agent" });

      expect(result.ok).toBe(true);
      expect(result).toHaveProperty(
        "value.jobs.my-job.fsm.states.step_0.entry.0.prompt",
        "Keep this",
      );
    });
  });

  describe("LLM agent updates (type: llm)", () => {
    test("updates prompt for LLM agent", () => {
      const config = createTestConfig({
        jobs: {
          "my-job": createFSMJob([
            { type: "llm", provider: "anthropic", model: "claude-sonnet-4-6", prompt: "Original" },
          ]),
        },
      });

      const result = updateFSMAgent(config, "my-job:step_0", {
        type: "llm",
        prompt: "Updated LLM prompt",
      });

      expect(result.ok).toBe(true);
      expect(result).toHaveProperty(
        "value.jobs.my-job.fsm.states.step_0.entry.0.prompt",
        "Updated LLM prompt",
      );
    });

    test("updates model for LLM agent", () => {
      const config = createTestConfig({
        jobs: {
          "my-job": createFSMJob([
            { type: "llm", provider: "anthropic", model: "claude-sonnet-4-6", prompt: "Test" },
          ]),
        },
      });

      const result = updateFSMAgent(config, "my-job:step_0", {
        type: "llm",
        model: "claude-opus-4-6",
      });

      expect(result.ok).toBe(true);
      expect(result).toHaveProperty(
        "value.jobs.my-job.fsm.states.step_0.entry.0.model",
        "claude-opus-4-6",
      );
    });

    test("updates multiple fields at once", () => {
      const config = createTestConfig({
        jobs: {
          "my-job": createFSMJob([
            { type: "llm", provider: "anthropic", model: "claude-sonnet-4-6", prompt: "Original" },
          ]),
        },
      });

      const result = updateFSMAgent(config, "my-job:step_0", {
        type: "llm",
        prompt: "New prompt",
        model: "claude-opus-4-6",
      });

      expect(result.ok).toBe(true);
      expect(result).toHaveProperty(
        "value.jobs.my-job.fsm.states.step_0.entry.0",
        expect.objectContaining({ prompt: "New prompt", model: "claude-opus-4-6" }),
      );
    });

    test("preserves provider when updating other fields", () => {
      const config = createTestConfig({
        jobs: {
          "my-job": createFSMJob([
            { type: "llm", provider: "openai", model: "gpt-4", prompt: "Test" },
          ]),
        },
      });

      const result = updateFSMAgent(config, "my-job:step_0", { type: "llm", prompt: "Updated" });

      expect(result.ok).toBe(true);
      expect(result).toHaveProperty(
        "value.jobs.my-job.fsm.states.step_0.entry.0.provider",
        "openai",
      );
    });
  });

  describe("immutability", () => {
    test("does not mutate original config", () => {
      const config = createTestConfig({
        jobs: {
          "my-job": createFSMJob([{ type: "agent", agentId: "research", prompt: "Original" }]),
        },
      });
      const originalJobsRef = config.jobs;
      const originalPrompt = (
        config.jobs?.["my-job"] as { fsm: { states: { step_0: { entry: [{ prompt?: string }] } } } }
      ).fsm.states.step_0.entry[0].prompt;

      updateFSMAgent(config, "my-job:step_0", { type: "agent", prompt: "Updated" });

      expect(config.jobs).toBe(originalJobsRef);
      expect(
        (
          config.jobs?.["my-job"] as {
            fsm: { states: { step_0: { entry: [{ prompt?: string }] } } };
          }
        ).fsm.states.step_0.entry[0].prompt,
      ).toBe(originalPrompt);
    });
  });
});
