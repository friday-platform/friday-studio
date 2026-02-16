import type { ValidatedJSONSchema } from "@atlas/core/artifacts";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceBlueprint } from "../types.ts";
import {
  addConstant,
  addSourceMapping,
  addTransformMapping,
  createMappingAccumulator,
  finalize,
  type MappingContext,
} from "./mapping-accumulator.ts";
import { ValidationExecutor } from "./validation-executor.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const sourceSchema: ValidatedJSONSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    count: { type: "number" },
    queries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sql: { type: "string" },
          result: { type: "object", properties: { rows: { type: "number" } } },
        },
      },
    },
  },
};

/** Consumer input schema (simulates a bundled agent with inputJsonSchema) */
const consumerInputSchema: ValidatedJSONSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    total: { type: "number" },
    channel: { type: "string" },
  },
};

const plan: WorkspaceBlueprint = {
  workspace: { name: "test", purpose: "testing" },
  signals: [],
  agents: [
    { id: "source-llm", name: "Source Agent", description: "Produces data", needs: ["source"] },
    {
      id: "consumer-llm",
      name: "Consumer Agent",
      description: "Consumes data",
      needs: ["consumer"],
    },
  ],
  jobs: [
    {
      id: "job-1",
      name: "Test Job",
      title: "Test",
      triggerSignalId: "sig-1",
      steps: [
        {
          id: "step-source",
          agentId: "source-llm",
          description: "Source",
          depends_on: [],
          executionType: "llm",
        },
        {
          id: "step-consumer",
          agentId: "consumer-llm",
          description: "Consumer",
          depends_on: ["step-source"],
          executionType: "llm",
        },
      ],
      documentContracts: [],
      prepareMappings: [],
    },
  ],
};

function makeContext(overrides?: Partial<MappingContext>): MappingContext {
  return {
    plan,
    stepOutputSchemas: new Map([["step-source", sourceSchema]]),
    sourceDocId: "step-source-output",
    sourceStepId: "step-source",
    consumerStepId: "step-consumer",
    consumerInputSchema: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// addSourceMapping
// ---------------------------------------------------------------------------

describe("addSourceMapping", () => {
  it("accepts valid fromPath and adds to accumulator", () => {
    const acc = createMappingAccumulator();
    const ctx = makeContext();

    const result = addSourceMapping(acc, ctx, {
      fromDoc: "step-source-output",
      fromPath: "summary",
      toField: "summary",
    });

    expect(result).toEqual({ accepted: true });
    expect(acc.sources).toEqual([{ from: "summary", to: "summary" }]);
  });

  it("rejects invalid fromPath with available fields", () => {
    const acc = createMappingAccumulator();
    const ctx = makeContext();

    const result = addSourceMapping(acc, ctx, {
      fromDoc: "step-source-output",
      fromPath: "nonexistent",
      toField: "summary",
    });

    expect(result).toEqual({
      accepted: false,
      error: 'fromPath "nonexistent" does not resolve in source schema',
      available: ["summary", "count", "queries"],
    });
    expect(acc.sources).toHaveLength(0);
  });

  it("accepts nested path with array access", () => {
    const acc = createMappingAccumulator();
    const ctx = makeContext();

    const result = addSourceMapping(acc, ctx, {
      fromDoc: "step-source-output",
      fromPath: "queries[].sql",
      toField: "query_text",
    });

    expect(result).toEqual({ accepted: true });
    expect(acc.sources).toEqual([{ from: "queries[].sql", to: "query_text" }]);
  });

  it("validates toField against consumer input schema when present", () => {
    const acc = createMappingAccumulator();
    const ctx = makeContext({ consumerInputSchema });

    const result = addSourceMapping(acc, ctx, {
      fromDoc: "step-source-output",
      fromPath: "summary",
      toField: "summary",
    });

    expect(result).toEqual({ accepted: true });
    expect(acc.sources).toEqual([{ from: "summary", to: "summary" }]);
  });

  it("rejects toField not in consumer input schema", () => {
    const acc = createMappingAccumulator();
    const ctx = makeContext({ consumerInputSchema });

    const result = addSourceMapping(acc, ctx, {
      fromDoc: "step-source-output",
      fromPath: "summary",
      toField: "nonexistent_field",
    });

    expect(result).toEqual({
      accepted: false,
      error:
        '"nonexistent_field" is not a valid field in the consumer\'s input schema. Available: summary, total, channel',
      available: ["summary", "total", "channel"],
    });
    expect(acc.sources).toHaveLength(0);
  });

  it("returns error when source step has no schema", () => {
    const acc = createMappingAccumulator();
    const ctx = makeContext({ stepOutputSchemas: new Map() });

    const result = addSourceMapping(acc, ctx, {
      fromDoc: "step-source-output",
      fromPath: "summary",
      toField: "summary",
    });

    expect(result).toEqual({
      accepted: false,
      error: 'No output schema available for step "step-source" (agent "source-llm")',
    });
  });
});

// ---------------------------------------------------------------------------
// addConstant
// ---------------------------------------------------------------------------

describe("addConstant", () => {
  it("accepts constant and adds to accumulator (no consumer schema)", () => {
    const acc = createMappingAccumulator();
    const ctx = makeContext({ consumerInputSchema: undefined });

    const result = addConstant(acc, ctx, { key: "mode", value: "batch" });

    expect(result).toEqual({ accepted: true });
    expect(acc.constants).toEqual([{ key: "mode", value: "batch" }]);
  });

  it("validates key exists in consumer input schema", () => {
    const acc = createMappingAccumulator();
    const ctx = makeContext({ consumerInputSchema });

    const result = addConstant(acc, ctx, { key: "channel", value: "#general" });

    expect(result).toEqual({ accepted: true });
    expect(acc.constants).toEqual([{ key: "channel", value: "#general" }]);
  });

  it("rejects key not in consumer input schema", () => {
    const acc = createMappingAccumulator();
    const ctx = makeContext({ consumerInputSchema });

    const result = addConstant(acc, ctx, { key: "bogus", value: "nope" });

    expect(result).toEqual({
      accepted: false,
      error:
        '"bogus" is not a valid field in the consumer\'s input schema. Available: summary, total, channel',
      available: ["summary", "total", "channel"],
    });
    expect(acc.constants).toHaveLength(0);
  });

  it("validates value type matches consumer schema", () => {
    const acc = createMappingAccumulator();
    const ctx = makeContext({ consumerInputSchema });

    // total expects number, giving string
    const result = addConstant(acc, ctx, { key: "total", value: "not-a-number" });

    expect(result).toEqual({
      accepted: false,
      error: 'Constant "total" expects type "number" but got string',
    });
    expect(acc.constants).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

describe("finalize", () => {
  it("returns confirmation with accumulated mapping state", () => {
    const acc = createMappingAccumulator();
    const ctx = makeContext();

    addSourceMapping(acc, ctx, {
      fromDoc: "step-source-output",
      fromPath: "summary",
      toField: "summary",
    });
    addConstant(acc, ctx, { key: "mode", value: "batch" });

    expect(finalize(acc)).toEqual({ status: "finalized", sourcesCount: 1, constantsCount: 1 });
  });
});

// ---------------------------------------------------------------------------
// addTransformMapping (requires Deno worker runtime)
// ---------------------------------------------------------------------------

/** Schema for a second upstream step used in cross-document tests */
const taxConfigSchema: ValidatedJSONSchema = {
  type: "object",
  properties: { rate: { type: "number" }, region: { type: "string" } },
};

/** Plan with two upstream steps for fan-in / cross-doc tests */
const fanInPlan: WorkspaceBlueprint = {
  workspace: { name: "test", purpose: "testing" },
  signals: [],
  agents: [
    { id: "source-llm", name: "Source Agent", description: "Produces data", needs: ["source"] },
    { id: "tax-llm", name: "Tax Agent", description: "Tax config", needs: ["tax"] },
    {
      id: "consumer-llm",
      name: "Consumer Agent",
      description: "Consumes data",
      needs: ["consumer"],
    },
  ],
  jobs: [
    {
      id: "job-1",
      name: "Test Job",
      title: "Test",
      triggerSignalId: "sig-1",
      steps: [
        {
          id: "step-source",
          agentId: "source-llm",
          description: "Source",
          depends_on: [],
          executionType: "llm",
        },
        {
          id: "step-tax",
          agentId: "tax-llm",
          description: "Tax config",
          depends_on: [],
          executionType: "llm",
        },
        {
          id: "step-consumer",
          agentId: "consumer-llm",
          description: "Consumer",
          depends_on: ["step-source", "step-tax"],
          executionType: "llm",
        },
      ],
      documentContracts: [],
      prepareMappings: [],
    },
  ],
};

function makeTransformContext(overrides?: Partial<MappingContext>): MappingContext {
  return {
    plan: fanInPlan,
    stepOutputSchemas: new Map([
      ["step-source", sourceSchema],
      ["step-tax", taxConfigSchema],
    ]),
    sourceDocId: "step-source-output",
    sourceStepId: "step-source",
    consumerStepId: "step-consumer",
    consumerInputSchema: undefined,
    ...overrides,
  };
}

describe.skipIf(!("Deno" in globalThis))("addTransformMapping", () => {
  let executor: ValidationExecutor;

  afterEach(() => {
    executor?.dispose();
  });

  it("accepts a valid transform expression and adds to accumulator", async () => {
    executor = new ValidationExecutor();
    const acc = createMappingAccumulator();
    const ctx = makeTransformContext({ executor });

    const result = await addTransformMapping(acc, ctx, {
      fromDoc: "step-source-output",
      fromPath: "count",
      toField: "doubled",
      transform: "value * 2",
      description: "Double the count",
    });

    expect(result).toEqual({ accepted: true });
    expect(acc.sources).toEqual([
      { from: "count", to: "doubled", transform: "value * 2", description: "Double the count" },
    ]);
  });

  it("rejects syntax errors without spawning worker", async () => {
    executor = new ValidationExecutor();
    const acc = createMappingAccumulator();
    const ctx = makeTransformContext({ executor });

    const result = await addTransformMapping(acc, ctx, {
      fromDoc: "step-source-output",
      fromPath: "count",
      toField: "result",
      transform: "value.(",
      description: "Bad syntax",
    });

    expect(result).toMatchObject({
      accepted: false,
      error: expect.stringContaining("Syntax error"),
    });
    expect(acc.sources).toHaveLength(0);
  });

  it("rejects runtime errors with mock data snapshot", async () => {
    executor = new ValidationExecutor();
    const acc = createMappingAccumulator();
    const ctx = makeTransformContext({ executor });

    const result = await addTransformMapping(acc, ctx, {
      fromDoc: "step-source-output",
      fromPath: "summary",
      toField: "result",
      transform: "value.nonexistent.deep",
      description: "Access missing property",
    });

    expect(result).toMatchObject({
      accepted: false,
      error: expect.stringContaining("Transform execution failed"),
      mockData: expect.objectContaining({ value: expect.anything() }),
      availableFields: expect.any(Array),
    });
    expect(acc.sources).toHaveLength(0);
  });

  it("rejects type mismatch for bundled agent consumer", async () => {
    executor = new ValidationExecutor();
    const acc = createMappingAccumulator();
    const ctx = makeTransformContext({ executor, consumerInputSchema });

    const result = await addTransformMapping(acc, ctx, {
      fromDoc: "step-source-output",
      fromPath: "summary",
      toField: "total",
      transform: "value.toUpperCase()",
      description: "Uppercase the summary (wrong type for total)",
    });

    expect(result).toMatchObject({
      accepted: false,
      error: expect.stringContaining("type mismatch"),
      mockData: expect.objectContaining({ value: expect.anything() }),
    });
    expect(acc.sources).toHaveLength(0);
  });

  it("accepts cross-document expression using docs binding", async () => {
    executor = new ValidationExecutor();
    const acc = createMappingAccumulator();
    const ctx = makeTransformContext({ executor });

    const result = await addTransformMapping(acc, ctx, {
      fromDoc: "step-source-output",
      fromPath: "count",
      toField: "taxed_count",
      transform: "value * docs['step-tax-output'].rate",
      description: "Multiply count by tax rate",
    });

    expect(result).toEqual({ accepted: true });
    expect(acc.sources).toEqual([
      {
        from: "count",
        to: "taxed_count",
        transform: "value * docs['step-tax-output'].rate",
        description: "Multiply count by tax rate",
      },
    ]);
  });

  it("rejects transform accessing nonexistent array item properties", async () => {
    executor = new ValidationExecutor();
    const acc = createMappingAccumulator();
    const ctx = makeTransformContext({ executor });

    const result = await addTransformMapping(acc, ctx, {
      fromDoc: "step-source-output",
      fromPath: "queries",
      toField: "emails",
      transform: "value.map(q => q.email).filter(Boolean)",
      description: "Extract emails from queries (field does not exist)",
    });

    expect(result).toMatchObject({
      accepted: false,
      error: expect.stringContaining("empty array from non-empty input"),
      availableFields: ["sql", "result"],
    });
    expect(acc.sources).toHaveLength(0);
  });

  it("rejects invalid fromPath", async () => {
    executor = new ValidationExecutor();
    const acc = createMappingAccumulator();
    const ctx = makeTransformContext({ executor });

    const result = await addTransformMapping(acc, ctx, {
      fromDoc: "step-source-output",
      fromPath: "nonexistent",
      toField: "result",
      transform: "value",
      description: "Pass through",
    });

    expect(result).toEqual({
      accepted: false,
      error: 'fromPath "nonexistent" does not resolve in source schema',
      availableFields: ["summary", "count", "queries"],
    });
    expect(acc.sources).toHaveLength(0);
  });
});
