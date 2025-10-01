/**
 * Atlas Configuration v2 Schemas
 *
 * This module exports comprehensive Zod schemas for Atlas configuration
 * with improved type safety, tagged unions, and clear separation of concerns.
 */
import { convertJsonSchemaToZod } from "zod-from-json-schema";

// Agent schemas with tagged unions
export * from "./src/agents.ts";
// Atlas-specific schemas
export * from "./src/atlas.ts";
// Base types and enums
export * from "./src/base.ts";
// Configuration loader
export * from "./src/config-loader.ts";

// Job specification schemas
export * from "./src/jobs.ts";
// MCP schemas (Platform and Protocol)
export * from "./src/mcp.ts";
// Memory configuration schemas
export * from "./src/memory.ts";
// Notification configuration schemas
export * from "./src/notifications.ts";
// Signal schemas with tagged unions
export * from "./src/signals.ts";
// Supervisor defaults
export {
  type SupervisorDefaults,
  supervisorDefaults,
  supervisorDefaultsWrapped,
} from "./src/supervisor-defaults.ts";
export * from "./src/workspace.ts";

// ==============================================================================
// HELPER FUNCTIONS
// ==============================================================================

import { stringifyError } from "@atlas/utils";
import { z } from "zod";
import type {
  LLMAgentConfig,
  SystemAgentConfig,
  WorkspaceAgentConfig,
  WorkspaceAgentConfigSchema,
} from "./src/agents.ts";
import type { JobSpecificationSchema } from "./src/jobs.ts";
import type { WorkspaceSignalConfig } from "./src/signals.ts";
import type { MergedConfig } from "./src/workspace.ts";

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
export function getSignal(config: MergedConfig, name: string): WorkspaceSignalConfig | undefined {
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
export function isSystemSignal(signal: WorkspaceSignalConfig): boolean {
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

export type SignalPayload = { success: true; data: unknown } | { success: false; error: string };

/**
 * Validate a signal payload against its schema
 */
export function validateSignalPayload(
  signal: WorkspaceSignalConfig,
  payload: unknown,
): SignalPayload {
  if (!signal.schema) {
    return { success: true, data: payload };
  }
  let zodSchema: ReturnType<typeof convertJsonSchemaToZod>;
  try {
    zodSchema = convertJsonSchemaToZod(signal.schema);
  } catch (e) {
    return { success: false, error: stringifyError(e) };
  }
  try {
    const validatedData = zodSchema.parse(payload);
    return { success: true, data: validatedData };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: z.prettifyError(error) };
    }
    return { success: false, error: stringifyError(error) };
  }
}
