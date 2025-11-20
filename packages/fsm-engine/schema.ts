/**
 * Zod schemas for runtime validation of FSM definitions
 */

import { z } from "zod";

/**
 * JSON Schema validation schema
 * Supports a subset of JSON Schema for document type definitions
 */
export const JSONSchemaSchema: z.ZodType<{
  type?: "object" | "array" | "string" | "number" | "boolean" | "null";
  properties?: Record<string, unknown>;
  items?: unknown;
  required?: string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | unknown;
  description?: string;
}> = z.lazy(() =>
  z.object({
    type: z.enum(["object", "array", "string", "number", "boolean", "null"]).optional(),
    properties: z.record(z.string(), JSONSchemaSchema).optional(),
    items: JSONSchemaSchema.optional(),
    required: z.array(z.string()).optional(),
    enum: z.array(z.unknown()).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    pattern: z.string().optional(),
    additionalProperties: z.union([z.boolean(), JSONSchemaSchema]).optional(),
    description: z.string().optional(),
  }),
);

export const DocumentSchema = z.object({
  id: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export const LLMActionSchema = z.object({
  type: z.literal("llm"),
  provider: z.string(),
  model: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).optional(),
  outputTo: z.string().optional(),
});

export const CodeActionSchema = z.object({ type: z.literal("code"), function: z.string() });

export const EmitActionSchema = z.object({
  type: z.literal("emit"),
  event: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const AgentActionSchema = z.object({
  type: z.literal("agent"),
  agentId: z.string(),
  outputTo: z.string().optional(),
});

export const ActionSchema = z.discriminatedUnion("type", [
  LLMActionSchema,
  CodeActionSchema,
  EmitActionSchema,
  AgentActionSchema,
]);

export const TransitionDefinitionSchema = z.object({
  target: z.string(),
  guards: z.array(z.string()).optional(),
  actions: z.array(ActionSchema).optional(),
});

export const StateDefinitionSchema = z.object({
  documents: z.array(DocumentSchema).optional(),
  entry: z.array(ActionSchema).optional(),
  on: z
    .record(z.string(), z.union([TransitionDefinitionSchema, z.array(TransitionDefinitionSchema)]))
    .optional(),
  type: z.literal("final").optional(),
});

export const FunctionDefinitionSchema = z.object({
  type: z.enum(["guard", "action"]),
  code: z.string(),
});

export const ToolFunctionDefinitionSchema = z.object({
  description: z.string(),
  inputSchema: JSONSchemaSchema,
  code: z.string(),
});

export const FSMDefinitionSchema = z.object({
  id: z.string(),
  initial: z.string(),
  states: z.record(z.string(), StateDefinitionSchema),
  functions: z.record(z.string(), FunctionDefinitionSchema).optional(),
  tools: z.record(z.string(), ToolFunctionDefinitionSchema).optional(),
  documentTypes: z.record(z.string(), JSONSchemaSchema).optional(),
});

export const SignalSchema = z.object({
  type: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

// Export inferred types for use in implementation
export type ValidatedFSMDefinition = z.infer<typeof FSMDefinitionSchema>;
export type ValidatedStateDefinition = z.infer<typeof StateDefinitionSchema>;
export type ValidatedDocument = z.infer<typeof DocumentSchema>;
export type ValidatedAction = z.infer<typeof ActionSchema>;
export type ValidatedSignal = z.infer<typeof SignalSchema>;
export type ValidatedJSONSchema = z.infer<typeof JSONSchemaSchema>;
