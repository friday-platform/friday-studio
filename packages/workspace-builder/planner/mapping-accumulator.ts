import type { ValidatedJSONSchema } from "@atlas/core/artifacts";
import { resolveFieldPath, validateFieldPath } from "../compiler/validate-field-path.ts";
import type { WorkspaceBlueprint } from "../types.ts";
import { generateStubFromSchema } from "./generate-stub.ts";
import { lookupOutputSchema } from "./tools.ts";
import type { ValidationExecutor } from "./validation-executor.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Accumulates validated mapping operations during Phase 3b tool calls.
 * Only accepted operations enter the accumulator.
 */
export type MappingAccumulator = {
  sources: Array<{ from: string; to: string; transform?: string; description?: string }>;
  constants: Array<{ key: string; value: unknown }>;
};

/**
 * Context required by accumulator tools.
 * Closed over by buildMappingTools in phase3-contracts.ts.
 */
export type MappingContext = {
  plan: WorkspaceBlueprint;
  stepOutputSchemas: Map<string, ValidatedJSONSchema>;
  sourceDocId: string;
  sourceStepId: string;
  consumerStepId: string;
  /** Consumer's input JSON schema. undefined for LLM agents (no schema validation). */
  consumerInputSchema: ValidatedJSONSchema | undefined;
  /** Sandboxed expression executor. Required for addTransformMapping. */
  executor?: ValidationExecutor;
};

type AcceptedResult = { accepted: true };
type RejectedResult = { accepted: false; error: string; available?: string[] };
type TransformRejectedResult = {
  accepted: false;
  error: string;
  mockData?: { value: unknown; docs: Record<string, unknown> };
  availableFields?: string[];
};
type AddResult = AcceptedResult | RejectedResult;
type TransformAddResult = AcceptedResult | TransformRejectedResult;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMappingAccumulator(): MappingAccumulator {
  return { sources: [], constants: [] };
}

// ---------------------------------------------------------------------------
// addSourceMapping
// ---------------------------------------------------------------------------

/**
 * Validate and add a source field mapping to the accumulator.
 *
 * Validates:
 * 1. fromPath resolves against the source step's output schema
 * 2. toField exists in consumer's inputJsonSchema (bundled agents only)
 *
 * Rejected operations return available fields and never enter the accumulator.
 */
export function addSourceMapping(
  acc: MappingAccumulator,
  ctx: MappingContext,
  input: { fromDoc: string; fromPath: string; toField: string },
): AddResult {
  // Resolve source schema
  const lookupResult = lookupOutputSchema(ctx.sourceStepId, {
    plan: ctx.plan,
    stepOutputSchemas: ctx.stepOutputSchemas,
  });

  if ("error" in lookupResult) {
    return { accepted: false, error: lookupResult.error };
  }

  // Validate fromPath against source schema
  const pathResult = validateFieldPath(lookupResult.schema, input.fromPath);
  if (!pathResult.valid) {
    return {
      accepted: false,
      error: `fromPath "${input.fromPath}" does not resolve in source schema`,
      available: pathResult.available,
    };
  }

  // Validate toField against consumer input schema (bundled agents only)
  if (ctx.consumerInputSchema) {
    const toFieldResult = validateToField(ctx.consumerInputSchema, input.toField);
    if (!toFieldResult.valid) {
      return { accepted: false, error: toFieldResult.error, available: toFieldResult.available };
    }
  }

  acc.sources.push({ from: input.fromPath, to: input.toField });
  return { accepted: true };
}

// ---------------------------------------------------------------------------
// addTransformMapping
// ---------------------------------------------------------------------------

/**
 * Validate and add a transform mapping to the accumulator.
 *
 * Validates:
 * 1. fromPath resolves against the source step's output schema
 * 2. toField exists in consumer's inputJsonSchema (bundled agents only)
 * 3. Expression parses as valid JS via `new Function()`
 * 4. Expression executes without error against schema-derived mock data
 * 5. Result type matches toField's type in consumer schema (bundled agents only)
 *
 * On failure: returns error, mock data snapshot, and available field suggestions.
 */
export async function addTransformMapping(
  acc: MappingAccumulator,
  ctx: MappingContext,
  input: {
    fromDoc: string;
    fromPath: string;
    toField: string;
    transform: string;
    description: string;
  },
): Promise<TransformAddResult> {
  if (!ctx.executor) {
    return { accepted: false, error: "No ValidationExecutor provided in context" };
  }

  // 1. Resolve source schema and validate fromPath
  const lookupResult = lookupOutputSchema(ctx.sourceStepId, {
    plan: ctx.plan,
    stepOutputSchemas: ctx.stepOutputSchemas,
  });

  if ("error" in lookupResult) {
    return { accepted: false, error: lookupResult.error };
  }

  const pathResult = validateFieldPath(lookupResult.schema, input.fromPath);
  if (!pathResult.valid) {
    return {
      accepted: false,
      error: `fromPath "${input.fromPath}" does not resolve in source schema`,
      availableFields: pathResult.available,
    };
  }

  // 2. Validate toField against consumer input schema (bundled agents only)
  if (ctx.consumerInputSchema) {
    const toFieldResult = validateToField(ctx.consumerInputSchema, input.toField);
    if (!toFieldResult.valid) {
      return {
        accepted: false,
        error: toFieldResult.error,
        availableFields: toFieldResult.available,
      };
    }
  }

  // 3. Syntax pre-check
  try {
    new Function("value", "docs", `return ${input.transform}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { accepted: false, error: `Syntax error in transform expression: ${msg}` };
  }

  // 4. Generate mock data
  const mockValue = generateMockValueAtPath(lookupResult.schema, input.fromPath);
  const mockDocs = generateMockDocs(ctx);

  // 5. Execute in sandbox
  const execResult = await ctx.executor.execute({
    expression: input.transform,
    mockValue,
    mockDocs,
  });

  if (!execResult.success) {
    return {
      accepted: false,
      error: `Transform execution failed: ${execResult.error}`,
      mockData: { value: mockValue, docs: mockDocs },
      availableFields: collectAvailableFields(mockDocs),
    };
  }

  // 6. Detect empty-result transforms on non-empty array input
  //    Catches transforms that access nonexistent properties on array items
  //    (e.g., value.map(x => x.email) when items only have name/title)
  if (
    Array.isArray(mockValue) &&
    mockValue.length > 0 &&
    Array.isArray(execResult.result) &&
    execResult.result.length === 0
  ) {
    const itemSchema = resolveFieldPath(lookupResult.schema, input.fromPath);
    const itemFields = itemSchema?.items ? availableItemFields(itemSchema.items) : [];

    return {
      accepted: false,
      error:
        `Transform produced an empty array from non-empty input. ` +
        `The expression likely references properties that don't exist on array items. ` +
        `Available item fields: ${itemFields.join(", ") || "(none)"}`,
      mockData: { value: mockValue, docs: mockDocs },
      availableFields: itemFields,
    };
  }

  // 7. Validate result type (bundled agents only)
  if (ctx.consumerInputSchema) {
    const typeError = validateValueType(ctx.consumerInputSchema, input.toField, execResult.result);
    if (typeError) {
      return {
        accepted: false,
        error: `Transform result type mismatch: ${typeError}`,
        mockData: { value: mockValue, docs: mockDocs },
      };
    }
  }

  acc.sources.push({
    from: input.fromPath,
    to: input.toField,
    transform: input.transform,
    description: input.description,
  });
  return { accepted: true };
}

// ---------------------------------------------------------------------------
// addConstant
// ---------------------------------------------------------------------------

/**
 * Validate and add a constant value to the accumulator.
 *
 * For bundled agent consumers: validates key exists in inputJsonSchema
 * and value matches the expected type.
 * For LLM agent consumers: accepts any key/value.
 */
export function addConstant(
  acc: MappingAccumulator,
  ctx: MappingContext,
  input: { key: string; value: unknown },
): AddResult {
  if (ctx.consumerInputSchema) {
    const toFieldResult = validateToField(ctx.consumerInputSchema, input.key);
    if (!toFieldResult.valid) {
      return { accepted: false, error: toFieldResult.error, available: toFieldResult.available };
    }

    // Validate value type matches schema
    const typeError = validateValueType(ctx.consumerInputSchema, input.key, input.value);
    if (typeError) {
      return { accepted: false, error: typeError };
    }
  }

  acc.constants.push({ key: input.key, value: input.value });
  return { accepted: true };
}

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

/** Signal that mapping construction is complete. Returns summary of accumulated state. */
export function finalize(acc: MappingAccumulator): {
  status: "finalized";
  sourcesCount: number;
  constantsCount: number;
} {
  return {
    status: "finalized",
    sourcesCount: acc.sources.length,
    constantsCount: acc.constants.length,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// ## Mock-data transform validation pipeline
//
// Transforms are arbitrary JS expressions the LLM proposes at planning time
// (e.g. `value.map(x => x.name).join(", ")`). We can't statically type-check
// JS expressions against JSON schemas, so instead we:
//
//   schema ──► generateMockValueAtPath ──► deterministic stub data
//                                              │
//                     expression + stub ──► sandbox execution (ValidationExecutor)
//                                              │
//                            result type ──► checked against consumer input schema
//
// generateMockValueAtPath resolves the dot-path (e.g. "queries[].sql") down
// the source schema tree, then hands the sub-schema to generateStubFromSchema
// (generate-stub.ts) which produces a representative value — strings become
// "mock_field", numbers become 42, arrays get one item, objects recurse into
// required properties. The stub is structurally faithful to the schema without
// needing real data.
//
// This lets us catch LLM mistakes at plan time rather than at execution:
// - Referencing fields that don't exist on array items (empty-result heuristic)
// - Type mismatches between transform output and consumer input
// - Runtime errors from malformed expressions
//
// When validation fails, the rejected result includes the mock data snapshot
// and available field names so the LLM can self-correct on the next tool call.

/**
 * Check that a field name exists as a top-level property in a JSON schema.
 */
function validateToField(
  schema: ValidatedJSONSchema,
  fieldName: string,
): { valid: true } | { valid: false; error: string; available: string[] } {
  if (!schema.properties) {
    return {
      valid: false,
      error: `Consumer schema has no properties; cannot validate "${fieldName}"`,
      available: [],
    };
  }

  if (!(fieldName in schema.properties)) {
    const available = Object.keys(schema.properties);
    return {
      valid: false,
      error: `"${fieldName}" is not a valid field in the consumer's input schema. Available: ${available.join(", ")}`,
      available,
    };
  }

  return { valid: true };
}

/** JSON Schema type → JS typeof mapping */
const SCHEMA_TYPE_TO_JS: Record<string, string> = {
  string: "string",
  number: "number",
  integer: "number",
  boolean: "boolean",
  object: "object",
  array: "object", // typeof [] === "object"
};

/**
 * Check that a value's JS type matches the expected JSON Schema type for a field.
 * Returns an error message or undefined if valid.
 */
function validateValueType(
  schema: ValidatedJSONSchema,
  key: string,
  value: unknown,
): string | undefined {
  if (!schema.properties) return undefined;

  const fieldSchema = schema.properties[key];
  if (!fieldSchema?.type) return undefined;

  const expectedJsType = SCHEMA_TYPE_TO_JS[fieldSchema.type];
  if (!expectedJsType) return undefined;

  const actualType = typeof value;

  // null is typeof "object" but shouldn't match object/array
  if (value === null && expectedJsType !== "object") {
    return `Constant "${key}" expects type "${fieldSchema.type}" but got null`;
  }

  // Array check for "array" schema type
  if (fieldSchema.type === "array" && !Array.isArray(value)) {
    return `Constant "${key}" expects type "array" but got ${actualType}`;
  }

  if (actualType !== expectedJsType) {
    return `Constant "${key}" expects type "${fieldSchema.type}" but got ${actualType}`;
  }

  return undefined;
}

/**
 * Generate mock data for the value at a specific fromPath in a schema.
 * Walks the schema to the target path and generates a stub from the sub-schema.
 */
function generateMockValueAtPath(schema: ValidatedJSONSchema, fromPath: string): unknown {
  const subSchema = resolveFieldPath(schema, fromPath);
  if (!subSchema) return undefined;
  return generateStubFromSchema(subSchema);
}

/**
 * Build mock docs object from all upstream step output schemas.
 * Keys are document IDs (stepId-output), values are stub data from schemas.
 */
function generateMockDocs(ctx: MappingContext): Record<string, unknown> {
  const docs: Record<string, unknown> = {};

  // Find consumer step's depends_on to get all upstream step IDs
  for (const job of ctx.plan.jobs) {
    const consumerStep = job.steps.find((s) => s.id === ctx.consumerStepId);
    if (!consumerStep) continue;

    for (const depId of consumerStep.depends_on) {
      const schema = ctx.stepOutputSchemas.get(depId);
      if (schema) {
        docs[`${depId}-output`] = generateStubFromSchema(schema);
      }
    }
  }
  return docs;
}

/**
 * List property names from an array items schema.
 * Used in error messages when a transform accesses nonexistent item fields.
 */
function availableItemFields(itemSchema: ValidatedJSONSchema): string[] {
  if (itemSchema.properties) {
    return Object.keys(itemSchema.properties);
  }
  return [];
}

/**
 * Collect available top-level field names from all documents in mockDocs.
 * Used for error messages when a transform fails.
 */
function collectAvailableFields(mockDocs: Record<string, unknown>): string[] {
  const fields: string[] = [];
  for (const [docId, data] of Object.entries(mockDocs)) {
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const key of Object.keys(data)) {
        fields.push(`docs['${docId}'].${key}`);
      }
    }
  }
  return fields;
}
