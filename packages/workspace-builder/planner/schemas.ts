import { repairJson } from "@atlas/agent-sdk";
import { bundledAgentsRegistry } from "@atlas/bundled-agents/registry";
import type { ValidatedJSONSchema } from "@atlas/core/artifacts";
import { JSONSchemaSchema } from "@atlas/core/artifacts";
import { getDefaultProviderOpts, registry } from "@atlas/llm";
import { createLogger } from "@atlas/logger";
import { generateObject } from "ai";
import { wrapAISDKModel } from "evalite/ai-sdk";
import { z } from "zod";
import type { Agent, DAGStep } from "../types.ts";

const logger = createLogger({ component: "proto-schemas" });

/**
 * Schema for a single field definition within the output.
 */
const FieldDefSchema = z.object({
  name: z.string().describe("Field name (snake_case)"),
  type: z.enum(["string", "number", "boolean", "object", "array"]).describe("JSON Schema type"),
  description: z.string().describe("What this field contains"),
  items: z
    .object({
      type: z.enum(["string", "number", "boolean", "object"]).describe("Element type"),
      properties: z
        .array(
          z.object({
            name: z.string().describe("Property name (snake_case)"),
            type: z
              .enum(["string", "number", "boolean", "array", "object"])
              .describe("Property type"),
            description: z.string().describe("What this property contains"),
          }),
        )
        .optional()
        .describe("Properties when items.type is 'object'"),
    })
    .optional()
    .describe("Required when type is 'array' — defines the array element schema"),
});

/**
 * Schema for LLM-generated output field definitions.
 * The LLM describes what fields an agent would produce, then we
 * convert to a proper JSON Schema object.
 *
 * `structure` controls the top-level shape:
 * - "single_object": fields are direct properties of the output object
 * - "array_of_objects": fields describe items in a collection, wrapped
 *   under a named key (collectionKey)
 */
const OutputFieldSchema = z.object({
  structure: z
    .enum(["single_object", "array_of_objects"])
    .describe(
      "Whether the agent produces a single object with these fields, " +
        "or a collection of objects (e.g. a list of events, rows, items)",
    ),
  collectionKey: z
    .string()
    .optional()
    .describe(
      "When structure is 'array_of_objects', the property name for the array (e.g. 'events', 'rows')",
    ),
  fields: z.array(FieldDefSchema),
});

/**
 * Build JSON Schema properties from a flat field list, handling nested
 * `items` for array-typed fields.
 */
function buildProperties(
  fields: z.infer<typeof OutputFieldSchema>["fields"],
): Record<string, ValidatedJSONSchema> {
  const properties: Record<string, ValidatedJSONSchema> = {};
  for (const field of fields) {
    if (field.type === "array" && field.items) {
      const itemSchema: ValidatedJSONSchema =
        field.items.type === "object" && field.items.properties
          ? {
              type: "object",
              properties: Object.fromEntries(
                field.items.properties.map((p) => {
                  const prop: ValidatedJSONSchema = { type: p.type, description: p.description };
                  if (p.type === "array") {
                    prop.items = { type: "string" };
                  } else if (p.type === "object") {
                    prop.additionalProperties = true;
                  }
                  return [p.name, prop];
                }),
              ),
              required: [field.items.properties[0]?.name].filter(Boolean),
              additionalProperties: true,
            }
          : { type: field.items.type };

      properties[field.name] = { type: "array", description: field.description, items: itemSchema };
    } else {
      properties[field.name] = { type: field.type, description: field.description };
    }
  }
  return properties;
}

/**
 * Convert LLM-generated field definitions to a JSON Schema object.
 *
 * When `structure` is "array_of_objects", wraps the fields under a
 * collection key as `{ [key]: { type: "array", items: { ... } } }`.
 */
function fieldsToJSONSchema(output: z.infer<typeof OutputFieldSchema>): ValidatedJSONSchema {
  const { structure, collectionKey, fields } = output;

  if (structure === "array_of_objects") {
    const key = collectionKey ?? "items";
    const itemProperties = buildProperties(fields);
    return {
      type: "object",
      properties: {
        [key]: {
          type: "array",
          items: {
            type: "object",
            properties: itemProperties,
            required: [fields[0]?.name].filter(Boolean),
            additionalProperties: true,
          },
        },
      },
      required: [key],
      additionalProperties: true,
    };
  }

  const properties = buildProperties(fields);
  return {
    type: "object",
    properties,
    required: [fields[0]?.name].filter(Boolean),
    additionalProperties: true,
  };
}

/**
 * Generate output schemas for all steps in a plan.
 *
 * - Bundled agents: reads `outputJsonSchema` from the registry (no LLM call)
 * - LLM agents: one `generateObject` call per step, parallelized
 *
 * @returns Map keyed by step ID → JSON Schema
 */
export async function generateOutputSchemas(
  steps: DAGStep[],
  agents: Agent[],
): Promise<Map<string, ValidatedJSONSchema>> {
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const schemas = new Map<string, ValidatedJSONSchema>();

  const llmSteps: Array<{ step: DAGStep; agent: Agent }> = [];

  // Resolve bundled agents synchronously
  for (const step of steps) {
    const agent = agentMap.get(step.agentId);
    const registryKey = agent?.bundledId ?? step.agentId;
    const registryEntry = bundledAgentsRegistry[registryKey];
    if (registryEntry?.outputJsonSchema) {
      schemas.set(step.id, registryEntry.outputJsonSchema);
      continue;
    }

    if (agent) {
      llmSteps.push({ step, agent });
    }
  }

  // Generate schemas for LLM agents in parallel
  if (llmSteps.length > 0) {
    const MAX_RETRIES = 3;
    const results = await Promise.all(
      llmSteps.map(async ({ step, agent }) => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            const result = await generateObject({
              model: wrapAISDKModel(registry.languageModel("anthropic:claude-sonnet-4-5")),
              schema: OutputFieldSchema,
              experimental_repairText: repairJson,
              messages: [
                {
                  role: "system",
                  content: `You define output schemas for AI agents. Given an agent's description and a step's task, describe what fields the agent would produce as structured output. Be specific and practical — focus on what the agent actually outputs, not metadata.

## Simplicity

Keep schemas minimal and flat. Name only the 1-3 most important output fields — the ones a downstream step would actually extract. The agent can produce additional data beyond what's in the schema.

Prefer a single narrative field (e.g. "summary") over many granular fields when the output is primarily text or analysis.

Schemas should be flat or at most one level of nesting. If the downstream step needs data extracted from deep in a structure, that extraction belongs in the agent's step description, not the schema. Never define schemas with 3+ levels of nesting.

When the agent produces a collection (array_of_objects), keep item schemas to 3-4 properties max. The items should capture the essential identity of each element, not every possible attribute.

## Structure Decision

First decide: does the agent produce a SINGLE object or a COLLECTION of objects?

- "single_object": The agent produces one result with distinct fields (e.g. a summary with title + body + sentiment)
- "array_of_objects": The agent produces a list of similar items (e.g. a list of events, search results, rows). Set collectionKey to a descriptive plural noun (e.g. "events", "results").

## Array Fields

When a field has type "array", you MUST provide "items" describing the element schema. If elements are objects, include "properties" on items.

## Type Constraints

Use ONLY these JSON Schema types: "string", "number", "boolean", "object", "array".
Do NOT use nullable types. For optional fields, simply omit them from "required".
Do NOT use union types — pick the single most appropriate type.`,
                  providerOptions: getDefaultProviderOpts("anthropic"),
                },
                {
                  role: "user",
                  content: `Agent: ${agent.name}
Description: ${agent.description}
Task: ${step.description}

What fields would this agent produce as its output?`,
                },
              ],
              maxOutputTokens: 2_048,
            });

            const schema = JSONSchemaSchema.parse(fieldsToJSONSchema(result.object));
            return { stepId: step.id, schema };
          } catch (err) {
            lastError = err;
            if (attempt < MAX_RETRIES) {
              logger.warn(`generateObject attempt ${attempt}/${MAX_RETRIES} failed, retrying`, {
                stepId: step.id,
              });
            }
          }
        }
        throw lastError;
      }),
    );

    for (const { stepId, schema } of results) {
      schemas.set(stepId, schema);
    }
  }

  return schemas;
}
