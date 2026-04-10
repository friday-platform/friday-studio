import type { BundledAgentConfigField } from "@atlas/bundled-agents";
import { bundledAgents, bundledAgentsRegistry } from "@atlas/bundled-agents";
import { Hono } from "hono";
import { listUserAgents } from "../lib/user-agents.ts";

/**
 * Maps a required config field to the API response shape.
 * Link fields use `envKey` as the key (the env var name set at runtime).
 */
function toRequiredConfigEntry(field: BundledAgentConfigField) {
  if (field.from === "link") {
    return { key: field.envKey, description: field.description, from: "link" as const };
  }
  return { key: field.key, description: field.description, from: "env" as const };
}

/**
 * Maps an optional config field to the API response shape.
 */
function toOptionalConfigEntry(field: BundledAgentConfigField) {
  if (field.from === "link") {
    return { key: field.envKey, description: field.description };
  }
  const entry: { key: string; description: string; default?: string } = {
    key: field.key,
    description: field.description,
  };
  if (field.default !== undefined) {
    entry.default = field.default;
  }
  return entry;
}

/**
 * GET /api/agents — returns metadata for all bundled + user agents.
 * Used by the agent selector UI and execute route.
 */
export const agentsRoute = new Hono().get("/", async (c) => {
  const agents = bundledAgents.flatMap((agent) => {
    const entry = bundledAgentsRegistry[agent.metadata.id];
    if (!entry) return [];

    return {
      id: entry.id,
      displayName: entry.name,
      description: entry.description,
      summary: entry.summary ?? "",
      constraints: agent.metadata.constraints ?? "",
      version: entry.version,
      examples: entry.examples,
      inputSchema: entry.inputJsonSchema ?? null,
      outputSchema: entry.outputJsonSchema ?? null,
      requiredConfig: entry.requiredConfig.map(toRequiredConfigEntry),
      optionalConfig: entry.optionalConfig.map(toOptionalConfigEntry),
    };
  });

  // Append user agents discovered from ~/.atlas/agents/
  const userAgents = await listUserAgents();
  for (const ua of userAgents) {
    agents.push({
      id: ua.id,
      displayName: ua.displayName ?? ua.id,
      description: ua.description ?? "",
      summary: "",
      constraints: "",
      version: ua.version ?? "0.0.0",
      examples: [],
      inputSchema: null,
      outputSchema: null,
      requiredConfig: [],
      optionalConfig: [],
    });
  }

  return c.json({ agents });
});
