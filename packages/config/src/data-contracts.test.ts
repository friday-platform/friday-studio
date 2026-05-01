/**
 * Tests for deriveDataContracts — extracts producer→consumer data flow
 * contracts from workspace FSM definitions.
 */

import { describe, expect, test } from "vitest";
import { deriveDataContracts } from "./data-contracts.ts";
import { createTestConfig } from "./mutations/test-fixtures.ts";

describe("deriveDataContracts", () => {
  test("extracts 3 contracts from PR review pipeline", () => {
    const config = createTestConfig({
      jobs: {
        "pr-code-review": {
          fsm: {
            id: "pr-pipeline",
            initial: "idle",
            states: {
              idle: { on: { "review-pr": { target: "step_clone_repo" } } },
              step_clone_repo: {
                entry: [
                  {
                    type: "agent",
                    agentId: "claude-code",
                    outputTo: "clone-output",
                    outputType: "clone-result",
                    prompt: "Clone it",
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
                    outputType: "code-review-result",
                    prompt: "Review it",
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
                    outputTo: "post-output",
                    outputType: "post-review-result",
                    prompt: "Post it",
                  },
                  { type: "emit", event: "ADVANCE" },
                ],
                on: { ADVANCE: { target: "completed" } },
              },
              completed: { type: "final" },
            },
            documentTypes: {
              "clone-result": { type: "object", properties: { response: { type: "string" } } },
              "code-review-result": {
                type: "object",
                properties: { response: { type: "string" } },
              },
              "post-review-result": {
                type: "object",
                properties: { response: { type: "string" } },
              },
            },
          },
        },
      },
    });

    const contracts = deriveDataContracts(config);

    expect(contracts).toHaveLength(3);

    expect(contracts[0]).toEqual({
      fromStepId: "step_clone_repo",
      fromStepName: "Clone Repo",
      toStepId: "step_review_pr",
      toStepName: "Review PR",
      documentType: "clone-result",
      schema: { type: "object", properties: { response: { type: "string" } } },
      jobId: "pr-code-review",
    });

    expect(contracts[1]).toEqual({
      fromStepId: "step_review_pr",
      fromStepName: "Review PR",
      toStepId: "step_post_review",
      toStepName: "Post Review",
      documentType: "code-review-result",
      schema: { type: "object", properties: { response: { type: "string" } } },
      jobId: "pr-code-review",
    });

    expect(contracts[2]).toEqual({
      fromStepId: "step_post_review",
      fromStepName: "Post Review",
      toStepId: null,
      toStepName: "(end)",
      documentType: "post-review-result",
      schema: { type: "object", properties: { response: { type: "string" } } },
      jobId: "pr-code-review",
    });
  });

  test("excludes steps without outputType", () => {
    const config = createTestConfig({
      jobs: {
        "simple-job": {
          fsm: {
            id: "simple",
            initial: "idle",
            states: {
              idle: { on: { START: { target: "step_process" } } },
              step_process: {
                entry: [
                  { type: "agent", agentId: "worker", prompt: "Do work" },
                  { type: "emit", event: "DONE" },
                ],
                on: { DONE: { target: "completed" } },
              },
              completed: { type: "final" },
            },
          },
        },
      },
    });

    const contracts = deriveDataContracts(config);

    expect(contracts).toHaveLength(0);
  });

  test("handles missing documentTypes definition gracefully", () => {
    const config = createTestConfig({
      jobs: {
        "no-docs-job": {
          fsm: {
            id: "no-docs",
            initial: "idle",
            states: {
              idle: { on: { START: { target: "step_work" } } },
              step_work: {
                entry: [
                  {
                    type: "agent",
                    agentId: "worker",
                    outputTo: "out",
                    outputType: "my-type",
                    prompt: "Work",
                  },
                  { type: "emit", event: "DONE" },
                ],
                on: { DONE: { target: "completed" } },
              },
              completed: { type: "final" },
            },
          },
        },
      },
    });

    const contracts = deriveDataContracts(config);

    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.schema).toBeNull();
    expect(contracts[0]?.documentType).toBe("my-type");
  });

  test("isolates contracts per job in multi-job workspace", () => {
    const config = createTestConfig({
      jobs: {
        "job-a": {
          fsm: {
            id: "a",
            initial: "idle",
            states: {
              idle: { on: { GO: { target: "step_one" } } },
              step_one: {
                entry: [
                  {
                    type: "agent",
                    agentId: "a1",
                    outputTo: "out-a",
                    outputType: "type-a",
                    prompt: "A",
                  },
                ],
                on: { NEXT: { target: "done" } },
              },
              done: { type: "final" },
            },
            documentTypes: { "type-a": { type: "object", properties: { a: { type: "string" } } } },
          },
        },
        "job-b": {
          fsm: {
            id: "b",
            initial: "idle",
            states: {
              idle: { on: { GO: { target: "step_two" } } },
              step_two: {
                entry: [
                  {
                    type: "agent",
                    agentId: "b1",
                    outputTo: "out-b",
                    outputType: "type-b",
                    prompt: "B",
                  },
                ],
                on: { NEXT: { target: "done" } },
              },
              done: { type: "final" },
            },
            documentTypes: { "type-b": { type: "object", properties: { b: { type: "number" } } } },
          },
        },
      },
    });

    const contracts = deriveDataContracts(config);

    expect(contracts).toHaveLength(2);
    expect(contracts[0]?.jobId).toBe("job-a");
    expect(contracts[0]?.documentType).toBe("type-a");
    expect(contracts[1]?.jobId).toBe("job-b");
    expect(contracts[1]?.documentType).toBe("type-b");
  });

  test("handles LLM actions with outputType", () => {
    const config = createTestConfig({
      jobs: {
        "llm-job": {
          fsm: {
            id: "llm",
            initial: "idle",
            states: {
              idle: { on: { GO: { target: "step_classify" } } },
              step_classify: {
                entry: [
                  {
                    type: "llm",
                    provider: "anthropic",
                    model: "claude-sonnet-4-6",
                    prompt: "Classify",
                    outputTo: "result",
                    outputType: "classification",
                  },
                ],
                on: { NEXT: { target: "done" } },
              },
              done: { type: "final" },
            },
            documentTypes: {
              classification: { type: "object", properties: { label: { type: "string" } } },
            },
          },
        },
      },
    });

    const contracts = deriveDataContracts(config);

    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.documentType).toBe("classification");
    expect(contracts[0]?.fromStepId).toBe("step_classify");
  });

  test("returns empty array when no jobs defined", () => {
    const config = createTestConfig({});

    const contracts = deriveDataContracts(config);

    expect(contracts).toEqual([]);
  });

  test("skips execution-mode jobs", () => {
    const config = createTestConfig({
      jobs: { "exec-job": { execution: { strategy: "sequential", agents: ["agent-1"] } } },
    });

    const contracts = deriveDataContracts(config);

    expect(contracts).toEqual([]);
  });

  test("producer to terminal state maps to null toStepId", () => {
    const config = createTestConfig({
      jobs: {
        "terminal-job": {
          fsm: {
            id: "terminal",
            initial: "idle",
            states: {
              idle: { on: { GO: { target: "step_final" } } },
              step_final: {
                entry: [
                  {
                    type: "agent",
                    agentId: "finalizer",
                    outputTo: "final-out",
                    outputType: "final-type",
                    prompt: "Finish",
                  },
                  { type: "emit", event: "DONE" },
                ],
                on: { DONE: { target: "end" } },
              },
              end: { type: "final" },
            },
          },
        },
      },
    });

    const contracts = deriveDataContracts(config);

    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.toStepId).toBeNull();
    expect(contracts[0]?.toStepName).toBe("(end)");
  });
});
