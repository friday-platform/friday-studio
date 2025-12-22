import { z } from "zod";

/**
 * JSON Schema validation schema for workspace signal payloads
 * Defines basic JSON Schema v7 structure for validating signal inputs
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

export type ValidatedJSONSchema = z.infer<typeof JSONSchemaSchema>;
