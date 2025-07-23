/**
 * Workspace utilities
 */

import type { WorkspaceConfig } from "@atlas/config";
import { WorkspaceConfigSchema } from "@atlas/config";
import type { ValidationResult } from "./types.ts";

/**
 * Validate workspace configuration using Zod schema
 */
export function validateWorkspace(config: unknown): ValidationResult {
  try {
    WorkspaceConfigSchema.parse(config);
    return { valid: true, errors: [], warnings: [] };
  } catch (error) {
    if (error instanceof Error) {
      return { valid: false, errors: [error.message], warnings: [] };
    }
    return { valid: false, errors: ["Unknown validation error"], warnings: [] };
  }
}

/**
 * Deep merge workspace configurations
 */
export function mergeConfigs(
  target: Partial<WorkspaceConfig>,
  source: Partial<WorkspaceConfig>,
): Partial<WorkspaceConfig> {
  const result: Record<string, unknown> = { ...target };

  for (const key in source) {
    const sourceValue = source[key as keyof WorkspaceConfig];
    const targetValue = target[key as keyof WorkspaceConfig];

    if (sourceValue === null || sourceValue === undefined) {
      continue;
    }

    if (Array.isArray(sourceValue)) {
      result[key] = [...sourceValue];
    } else if (
      sourceValue &&
      typeof sourceValue === "object" &&
      targetValue &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      result[key] = {
        ...targetValue,
        ...sourceValue,
      };
    } else {
      result[key] = sourceValue;
    }
  }

  return result as Partial<WorkspaceConfig>;
}

/**
 * Generate workspace configuration hash for change detection
 */
export async function hashConfig(config: unknown): Promise<string> {
  const configJson = JSON.stringify(config, Object.keys(config).sort());
  const encoder = new TextEncoder();
  const data = encoder.encode(configJson);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Check if running in test mode
 */
export function isTestMode(): boolean {
  return Deno.env.get("DENO_TEST") === "true";
}

/**
 * Format configuration for display
 */
export function formatConfigForDisplay(
  config: unknown,
  format: "yaml" | "json" | "summary",
): string {
  switch (format) {
    case "yaml":
      return JSON.stringify(config, null, 2); // Would use YAML library in real implementation
    case "json":
      return JSON.stringify(config, null, 2);
    case "summary":
      return `Configuration contains ${
        Object.keys(config as Record<string, unknown>).length
      } sections`;
    default:
      return JSON.stringify(config, null, 2);
  }
}
