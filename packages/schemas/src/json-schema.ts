import { z } from "zod";

/**
 * JSON Schema validation schema for workspace signal payloads
 * Defines basic JSON Schema v7 structure for validating signal inputs
 */
/**
 * Recursive shape for the JSONSchemaSchema type parameter.
 * Must be an interface (not inline) so TypeScript can resolve the self-reference.
 */
interface JSONSchemaShape {
  [key: string]: unknown;
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JSONSchemaShape>;
  items?: JSONSchemaShape;
  required?: string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JSONSchemaShape;
  description?: string;
}

export const JSONSchemaSchema: z.ZodType<JSONSchemaShape> = z.lazy(() =>
  z.object({
    type: z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]).optional(),
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

// ---------------------------------------------------------------------------
// Sanitization — parse raw schemas, stripping unsupported keywords
// ---------------------------------------------------------------------------

/**
 * Parse and sanitize a raw JSON Schema object, stripping keywords
 * unsupported by the FSM engine's schema compiler.
 *
 * `JSONSchemaSchema` only accepts engine-supported keywords; Zod's
 * `.parse()` discards anything else. Composition keywords
 * (`anyOf`/`oneOf`/`allOf`/`not`) must be resolved upstream before
 * schemas reach this point (e.g. at registry build time via
 * `sanitizeJsonSchema` in the bundled-agents package).
 *
 * @param raw - Unvalidated JSON Schema object
 * @returns Validated JSON Schema containing only engine-supported keywords
 */
export function sanitizeJsonSchema(raw: Record<string, unknown>): ValidatedJSONSchema {
  return JSONSchemaSchema.parse(raw);
}
