import process from "node:process";
import { z } from "zod";
import type { BundledAgentConfigField } from "../bundled-agents/registry.ts";
import type { RequiredConfigField } from "./schemas.ts";

/**
 * Missing field identified by validation
 */
const MissingFieldSchema = z.object({
  field: z.string().describe("Name of the missing field"),
  reason: z.string().describe("Why this field is missing or insufficient"),
});

export type MissingField = z.infer<typeof MissingFieldSchema>;

/**
 * Unified config field type (works with both bundled agents and MCP servers)
 */
type ConfigField = BundledAgentConfigField | RequiredConfigField;

/**
 * Validates that all required configuration fields are available in the system environment.
 *
 * All configuration for bundled agents and MCP servers comes from environment variables.
 * This function checks that each required field exists in the system environment.
 *
 * @param requiredConfig - Required configuration fields from matched integration
 * @returns Array of missing fields (empty if all requirements met)
 */
export function validateRequiredFields(requiredConfig: ConfigField[]): MissingField[] {
  // No required config = nothing to validate
  if (requiredConfig.length === 0) {
    return [];
  }

  const missingFields: MissingField[] = [];

  // Check all required fields in system environment
  for (const field of requiredConfig) {
    const envValue = process.env[field.key];
    if (!envValue) {
      missingFields.push({
        field: field.key,
        reason: `Environment variable ${field.key} is not set. ${field.description}`,
      });
    }
  }

  return missingFields;
}
