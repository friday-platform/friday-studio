/**
 * Tool Converter
 *
 * Since AtlasTool is now a direct alias of AI SDK Tool, these functions
 * are primarily for backwards compatibility and filtering operations.
 */

import type { AtlasTool } from "@atlas/agent-sdk";

/** Filter tools using allow/deny lists. */
export function filterTools(
  tools: Record<string, AtlasTool>,
  allowlist?: string[],
  denylist?: string[],
): Record<string, AtlasTool> {
  const result: Record<string, AtlasTool> = {};

  for (const [name, tool] of Object.entries(tools)) {
    if (denylist && denylist.includes(name)) {
      continue;
    }

    if (allowlist && !allowlist.includes(name)) {
      continue;
    }

    result[name] = tool;
  }

  return result;
}

/**
 * Merge tools from multiple sources.
 * Later sources override earlier ones for duplicate names.
 */
export function mergeTools(
  ...sources: Array<Record<string, AtlasTool>>
): Record<string, AtlasTool> {
  const result: Record<string, AtlasTool> = {};

  for (const source of sources) {
    Object.assign(result, source);
  }

  return result;
}
