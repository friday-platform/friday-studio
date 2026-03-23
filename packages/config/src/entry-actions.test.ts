/**
 * Tests for deriveEntryActions and deriveAllEntryActions — extracts typed
 * action descriptors from FSM state entry arrays for filmstrip rendering.
 */

import { describe, expect, test } from "vitest";
import { deriveAllEntryActions, deriveEntryActions } from "./entry-actions.ts";
import type { FSMStateDefinition } from "./mutations/fsm-types.ts";
import { createTestConfig } from "./mutations/test-fixtures.ts";

// ==============================================================================
// TESTS
// ==============================================================================

describe("deriveEntryActions", () => {
  test("extracts mixed action types in declaration order", () => {
    const state: FSMStateDefinition = {
      entry: [
        { type: "code", function: "prepare_clone" },
        { type: "agent", agentId: "claude-code", outputTo: "clone-output", prompt: "Clone it" },
        { type: "emit", event: "ADVANCE" },
      ],
      on: { ADVANCE: { target: "next_step" } },
    };

    const result = deriveEntryActions(state);

    expect(result).toEqual([
      { type: "code", name: "prepare_clone" },
      { type: "agent", name: "claude-code", agentId: "claude-code", outputTo: "clone-output" },
      { type: "emit", name: "ADVANCE", event: "ADVANCE" },
    ]);
  });

  test("extracts single code action", () => {
    const state: FSMStateDefinition = { entry: [{ type: "code", function: "cleanup" }] };

    const result = deriveEntryActions(state);

    expect(result).toEqual([{ type: "code", name: "cleanup" }]);
  });

  test("extracts agent action with outputTo and outputType", () => {
    const state: FSMStateDefinition = {
      entry: [
        {
          type: "agent",
          agentId: "researcher",
          outputTo: "research-doc",
          outputType: "research-result",
          prompt: "Research the topic",
        },
      ],
    };

    const result = deriveEntryActions(state);

    expect(result).toEqual([
      {
        type: "agent",
        name: "researcher",
        agentId: "researcher",
        outputTo: "research-doc",
        outputType: "research-result",
      },
    ]);
  });

  test("extracts llm action with provider/model name", () => {
    const state: FSMStateDefinition = {
      entry: [
        {
          type: "llm",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          prompt: "Classify this",
          outputTo: "classification",
          outputType: "classification-type",
        },
      ],
    };

    const result = deriveEntryActions(state);

    expect(result).toEqual([
      {
        type: "llm",
        name: "anthropic/claude-sonnet-4-6",
        outputTo: "classification",
        outputType: "classification-type",
      },
    ]);
  });

  test("extracts emit action with event name", () => {
    const state: FSMStateDefinition = {
      entry: [{ type: "emit", event: "DONE", data: { result: "ok" } }],
    };

    const result = deriveEntryActions(state);

    expect(result).toEqual([{ type: "emit", name: "DONE", event: "DONE" }]);
  });

  test("returns empty array for state with no entry actions", () => {
    const state: FSMStateDefinition = { on: { TRIGGER: { target: "next" } } };

    const result = deriveEntryActions(state);

    expect(result).toEqual([]);
  });

  test("returns empty array for state with empty entry array", () => {
    const state: FSMStateDefinition = { entry: [] };

    const result = deriveEntryActions(state);

    expect(result).toEqual([]);
  });

  test("returns empty array for final state", () => {
    const state: FSMStateDefinition = { type: "final" };

    const result = deriveEntryActions(state);

    expect(result).toEqual([]);
  });

  test("omits optional fields when not present on action", () => {
    const state: FSMStateDefinition = {
      entry: [{ type: "agent", agentId: "simple-agent", prompt: "Do it" }],
    };

    const result = deriveEntryActions(state);

    expect(result).toEqual([{ type: "agent", name: "simple-agent", agentId: "simple-agent" }]);
    // Verify outputTo is truly absent, not undefined
    expect(result[0]).not.toHaveProperty("outputTo");
  });
});

// ==============================================================================
// deriveAllEntryActions
// ==============================================================================

describe("deriveAllEntryActions", () => {
  test("keys entries by {jobId}:{stateId} for a single job with multiple states", () => {
    const config = createTestConfig({
      jobs: {
        "build-pipeline": {
          description: "Build pipeline",
          fsm: {
            id: "build",
            initial: "setup",
            states: {
              setup: {
                entry: [{ type: "code", function: "prepare_env" }],
                on: { READY: { target: "compile" } },
              },
              compile: {
                entry: [
                  { type: "agent", agentId: "builder", prompt: "Build it" },
                  { type: "emit", event: "DONE" },
                ],
                on: { DONE: { target: "finished" } },
              },
              finished: { type: "final" },
            },
          },
        },
      },
    });

    const result = deriveAllEntryActions(config);

    expect(result.size).toBe(2);
    expect(result.get("build-pipeline:setup")).toEqual([{ type: "code", name: "prepare_env" }]);
    expect(result.get("build-pipeline:compile")).toEqual([
      { type: "agent", name: "builder", agentId: "builder" },
      { type: "emit", name: "DONE", event: "DONE" },
    ]);
  });

  test("aggregates entry actions across multiple jobs", () => {
    const config = createTestConfig({
      jobs: {
        "job-a": {
          description: "Job A",
          fsm: {
            id: "a",
            initial: "step1",
            states: {
              step1: {
                entry: [{ type: "code", function: "fn_a" }],
                on: { NEXT: { target: "done" } },
              },
              done: { type: "final" },
            },
          },
        },
        "job-b": {
          description: "Job B",
          fsm: {
            id: "b",
            initial: "init",
            states: {
              init: {
                entry: [{ type: "emit", event: "STARTED" }],
                on: { STARTED: { target: "end" } },
              },
              end: { type: "final" },
            },
          },
        },
      },
    });

    const result = deriveAllEntryActions(config);

    expect(result.size).toBe(2);
    expect(result.get("job-a:step1")).toEqual([{ type: "code", name: "fn_a" }]);
    expect(result.get("job-b:init")).toEqual([{ type: "emit", name: "STARTED", event: "STARTED" }]);
  });

  test("returns empty map when config has no jobs", () => {
    const config = createTestConfig();

    const result = deriveAllEntryActions(config);

    expect(result.size).toBe(0);
  });

  test("skips execution-mode jobs (no fsm field)", () => {
    const config = createTestConfig({
      agents: {
        "test-agent": {
          type: "llm",
          description: "Test agent",
          config: { provider: "anthropic", model: "claude-sonnet-4-6", prompt: "Do stuff" },
        },
      },
      signals: { webhook: { provider: "http", description: "Webhook", config: { path: "/hook" } } },
      jobs: {
        "exec-job": {
          description: "Execution mode job",
          triggers: [{ signal: "webhook" }],
          execution: { agents: ["test-agent"] },
        },
      },
    });

    const result = deriveAllEntryActions(config);

    expect(result.size).toBe(0);
  });

  test("omits states that have no entry actions from the map", () => {
    const config = createTestConfig({
      jobs: {
        "sparse-pipeline": {
          description: "Has states with and without entry actions",
          fsm: {
            id: "sparse",
            initial: "idle",
            states: {
              idle: { on: { GO: { target: "work" } } },
              work: {
                entry: [{ type: "code", function: "do_work" }],
                on: { DONE: { target: "cleanup" } },
              },
              cleanup: {
                // no entry actions
                on: { FINISHED: { target: "end" } },
              },
              end: { type: "final" },
            },
          },
        },
      },
    });

    const result = deriveAllEntryActions(config);

    expect(result.size).toBe(1);
    expect(result.get("sparse-pipeline:work")).toEqual([{ type: "code", name: "do_work" }]);
    expect(result.has("sparse-pipeline:idle")).toBe(false);
    expect(result.has("sparse-pipeline:cleanup")).toBe(false);
    expect(result.has("sparse-pipeline:end")).toBe(false);
  });
});
