/**
 * Atlas Configuration v2 Schemas
 *
 * This module exports comprehensive Zod schemas for Atlas configuration
 * with improved type safety, tagged unions, and clear separation of concerns.
 */

// Base types and enums
export * from "./src/base.ts";

// MCP schemas (Platform and Protocol)
export * from "./src/mcp.ts";

// Signal schemas with tagged unions
export * from "./src/signals.ts";

// Agent schemas with tagged unions
export * from "./src/agents.ts";

// Job specification schemas
export * from "./src/jobs.ts";

// Memory configuration schemas
export * from "./src/memory.ts";

// Notification configuration schemas
export * from "./src/notifications.ts";

// Atlas-specific schemas
export * from "./src/atlas.ts";

// Main workspace configuration schemas
export * from "./src/workspace.ts";

// Configuration loader
export * from "./src/config-loader.ts";

// Supervisor defaults
export {
  type SupervisorDefaults,
  supervisorDefaults,
  supervisorDefaultsWrapped,
} from "./src/supervisor-defaults.ts";

// Helper function for formatting Zod errors
export function formatZodError(error: z.ZodError): string {
  return z.prettifyError(error);
}

// ==============================================================================
// HELPER FUNCTIONS
// ==============================================================================

import { z } from "zod/v4";
import { MergedConfig } from "./src/workspace.ts";
import { JobSpecificationSchema } from "./src/jobs.ts";
import { WorkspaceSignalConfigSchema } from "./src/signals.ts";
import {
  LLMAgentConfig,
  RemoteAgentConfig,
  SystemAgentConfig,
  WorkspaceAgentConfig,
  WorkspaceAgentConfigSchema,
} from "./src/agents.ts";

/**
 * Get a job by name from the configuration
 * Checks workspace first, then atlas
 */
export function getJob(
  config: MergedConfig,
  name: string,
): z.infer<typeof JobSpecificationSchema> | undefined {
  return config.workspace.jobs?.[name] || config.atlas?.jobs?.[name];
}

/**
 * Get a signal by name from the configuration
 * Checks workspace first, then atlas
 */
export function getSignal(
  config: MergedConfig,
  name: string,
): z.infer<typeof WorkspaceSignalConfigSchema> | undefined {
  return config.workspace.signals?.[name] || config.atlas?.signals?.[name];
}

/**
 * Get an agent by ID from the configuration
 * Checks workspace first, then atlas
 */
export function getAgent(
  config: MergedConfig,
  id: string,
): z.infer<typeof WorkspaceAgentConfigSchema> | undefined {
  return config.workspace.agents?.[id] || config.atlas?.agents?.[id];
}

/**
 * Check if a signal is a system signal
 */
export function isSystemSignal(signal: z.infer<typeof WorkspaceSignalConfigSchema>): boolean {
  return signal.provider === "system";
}

/**
 * Check if an agent is an LLM agent
 */
export function isLLMAgent(agent: WorkspaceAgentConfig): agent is LLMAgentConfig {
  return agent.type === "llm";
}

/**
 * Check if an agent is a system agent
 */
export function isSystemAgent(agent: WorkspaceAgentConfig): agent is SystemAgentConfig {
  return agent.type === "system";
}

/**
 * Check if an agent is a remote agent
 */
export function isRemoteAgent(agent: WorkspaceAgentConfig): agent is RemoteAgentConfig {
  return agent.type === "remote";
}

// ==============================================================================
// VALIDATION UTILITIES
// ==============================================================================

// Basic JSON Schema type definition for our use case
export type JsonSchema =
  | boolean
  | {
    type?: string | string[];
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema | JsonSchema[];
    enum?: unknown[];
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: boolean | number;
    exclusiveMaximum?: boolean | number;
    minItems?: number;
    maxItems?: number;
    default?: unknown;
    description?: string;
    additionalProperties?: boolean | JsonSchema;
    oneOf?: JsonSchema[];
    anyOf?: JsonSchema[];
    allOf?: JsonSchema[];
    $ref?: string;
  };

/**
 * Convert JSON Schema to Zod schema for runtime validation
 * Used for validating signal payloads against their schemas
 */
export function jsonSchemaToZod(jsonSchema: JsonSchema): z.ZodSchema<unknown> {
  // Handle boolean schemas
  if (typeof jsonSchema === "boolean") {
    return jsonSchema ? z.any() : z.never();
  }

  // Handle $ref (not supported)
  if (jsonSchema.$ref) {
    throw new Error("Unsupported JSON Schema feature: $ref");
  }

  // Handle combinators
  if (jsonSchema.oneOf) {
    return z.union(
      jsonSchema.oneOf.map((s) => jsonSchemaToZod(s)) as [
        z.ZodSchema,
        z.ZodSchema,
        ...z.ZodSchema[],
      ],
    );
  }

  if (jsonSchema.anyOf) {
    return z.union(
      jsonSchema.anyOf.map((s) => jsonSchemaToZod(s)) as [
        z.ZodSchema,
        z.ZodSchema,
        ...z.ZodSchema[],
      ],
    );
  }

  if (jsonSchema.allOf) {
    const schemas = jsonSchema.allOf.map((s) => jsonSchemaToZod(s));
    return schemas.reduce((acc, schema) => acc.and(schema), z.object({}));
  }

  if (!jsonSchema || !jsonSchema.type) {
    return z.any();
  }

  const type = Array.isArray(jsonSchema.type) ? jsonSchema.type[0] : jsonSchema.type;

  switch (type) {
    case "object": {
      const shape: Record<string, z.ZodSchema<unknown>> = {};
      if (jsonSchema.properties) {
        for (const [key, prop] of Object.entries(jsonSchema.properties)) {
          let fieldSchema = jsonSchemaToZod(prop);
          // Handle required fields
          if (!jsonSchema.required?.includes(key)) {
            fieldSchema = fieldSchema.optional();
          }
          shape[key] = fieldSchema;
        }
      }
      return jsonSchema.additionalProperties === false
        ? z.object(shape).strict()
        : jsonSchema.additionalProperties === true
        ? z.object(shape).passthrough()
        : typeof jsonSchema.additionalProperties === "object"
        ? z.object(shape).catchall(jsonSchemaToZod(jsonSchema.additionalProperties))
        : z.object(shape).passthrough();
    }

    case "string": {
      let stringSchema = z.string();
      if (jsonSchema.enum) {
        return z.enum(jsonSchema.enum as [string, ...string[]]);
      }
      if (jsonSchema.minLength) {
        stringSchema = stringSchema.min(jsonSchema.minLength);
      }
      if (jsonSchema.maxLength) {
        stringSchema = stringSchema.max(jsonSchema.maxLength);
      }
      if (jsonSchema.pattern) {
        stringSchema = stringSchema.regex(new RegExp(jsonSchema.pattern));
      }
      return stringSchema;
    }

    case "number": {
      let numberSchema = z.number();
      if (jsonSchema.minimum !== undefined) {
        if (jsonSchema.exclusiveMinimum === true) {
          numberSchema = numberSchema.gt(jsonSchema.minimum);
        } else {
          numberSchema = numberSchema.min(jsonSchema.minimum);
        }
      }
      if (jsonSchema.maximum !== undefined) {
        if (jsonSchema.exclusiveMaximum === true) {
          numberSchema = numberSchema.lt(jsonSchema.maximum);
        } else {
          numberSchema = numberSchema.max(jsonSchema.maximum);
        }
      }
      return numberSchema;
    }

    case "boolean":
      return z.boolean();

    case "array": {
      if (Array.isArray(jsonSchema.items)) {
        // Tuple
        return z.tuple(
          jsonSchema.items.map((s) => jsonSchemaToZod(s)) as [z.ZodSchema, ...z.ZodSchema[]],
        );
      }
      let arraySchema = z.array(jsonSchema.items ? jsonSchemaToZod(jsonSchema.items) : z.any());
      if (jsonSchema.minItems) {
        arraySchema = arraySchema.min(jsonSchema.minItems);
      }
      if (jsonSchema.maxItems) {
        arraySchema = arraySchema.max(jsonSchema.maxItems);
      }
      return arraySchema;
    }

    case "null":
      return z.null();

    case "integer": {
      let intSchema = z.number().int();
      if (jsonSchema.minimum !== undefined) {
        if (jsonSchema.exclusiveMinimum === true) {
          intSchema = intSchema.gt(jsonSchema.minimum);
        } else {
          intSchema = intSchema.min(jsonSchema.minimum);
        }
      }
      if (jsonSchema.maximum !== undefined) {
        if (jsonSchema.exclusiveMaximum === true) {
          intSchema = intSchema.lt(jsonSchema.maximum);
        } else {
          intSchema = intSchema.max(jsonSchema.maximum);
        }
      }
      return intSchema;
    }

    default:
      return z.any();
  }
}

/**
 * Validate a signal payload against its schema
 */
export function validateSignalPayload(
  signal: z.infer<typeof WorkspaceSignalConfigSchema>,
  payload: unknown,
): { success: true; data: unknown } | { success: false; error: string } {
  if (!signal.schema) {
    return { success: true, data: payload };
  }

  try {
    const zodSchema = jsonSchemaToZod(signal.schema);
    const validatedData = zodSchema.parse(payload);
    return { success: true, data: validatedData };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: z.prettifyError(error) };
    }
    return { success: false, error: String(error) };
  }
}
