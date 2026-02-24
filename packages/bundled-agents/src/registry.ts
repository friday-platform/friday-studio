import type { AgentEnvironmentConfig, AtlasAgent } from "@atlas/agent-sdk";
import type { ValidatedJSONSchema } from "@atlas/schemas/json-schema";
import { z } from "zod";
import { claudeCodeAgent } from "./claude-code/agent.ts";
import { csvFilterSamplerAgent } from "./csv/filter.ts";
import { dataAnalystAgent } from "./data-analyst/agent.ts";
import { emailAgent } from "./email/communicator.ts";
import { fathomGetTranscriptAgent } from "./fathom-ai/get-transcript.ts";
import { googleCalendarAgent } from "./google/calendar.ts";
import { slackCommunicatorAgent } from "./slack/communicator.ts";
import { summaryAgent } from "./summary.ts";
import { tableAgent } from "./table.ts";
import { webSearchAgent } from "./web-search/web-search.ts";

/**
 * All bundled agents in the order they're registered.
 * This array is the single source of truth - adding an agent here
 * automatically includes it in the registry.
 */
export const bundledAgents: AtlasAgent[] = [
  slackCommunicatorAgent,
  googleCalendarAgent,
  webSearchAgent,
  summaryAgent,
  emailAgent,
  fathomGetTranscriptAgent,
  claudeCodeAgent,
  csvFilterSamplerAgent,
  dataAnalystAgent,
  tableAgent,
];

/**
 * Configuration field for bundled agents.
 *
 * Two variants:
 * - `from: "env"` - Plain environment variable
 * - `from: "link"` - Link credential reference (resolved at runtime)
 */
export type BundledAgentConfigField =
  | {
      from: "env";
      key: string;
      description: string;
      type: "string" | "array" | "object" | "number" | "boolean";
      validation?: string;
      default?: string;
      examples?: string[];
    }
  | { from: "link"; envKey: string; provider: string; key: string; description: string };

/**
 * Converts agent environment config to registry config fields.
 * Maps from AgentEnvironmentConfig (on agent metadata) to BundledAgentConfigField[] (for registry consumers).
 */
function toConfigFields(envConfig: AgentEnvironmentConfig["required"]): BundledAgentConfigField[] {
  if (!envConfig) return [];

  return envConfig.map((field): BundledAgentConfigField => {
    if (field.linkRef) {
      // Link credential reference
      return {
        from: "link",
        envKey: field.name,
        provider: field.linkRef.provider,
        key: field.linkRef.key,
        description: field.description,
      };
    }
    // Plain environment variable
    return {
      from: "env",
      key: field.name,
      description: field.description,
      type: "string", // Default type, could be enhanced if agent metadata includes type info
      validation: field.validation,
    };
  });
}

/**
 * Converts optional env config to registry config fields.
 */
function toOptionalConfigFields(
  envConfig: AgentEnvironmentConfig["optional"],
): BundledAgentConfigField[] {
  if (!envConfig) return [];

  return envConfig.map(
    (field): BundledAgentConfigField => ({
      from: "env",
      key: field.name,
      description: field.description ?? "",
      type: "string",
      default: field.default,
    }),
  );
}

/**
 * Derive a registry entry from an agent instance.
 * Extracts all metadata from the agent, converts schemas to JSON Schema.
 */
function deriveRegistryEntry(agent: AtlasAgent) {
  const { metadata, environmentConfig } = agent;

  return {
    // Identity
    id: metadata.id,
    name: metadata.displayName ?? metadata.id,
    description: metadata.description,
    version: metadata.version,

    // Classification
    examples: metadata.expertise.examples,

    // Configuration (derived from environment config)
    requiredConfig: toConfigFields(environmentConfig?.required),
    optionalConfig: toOptionalConfigFields(environmentConfig?.optional),

    // Schemas (Zod → JSON Schema, engine compatibility enforced by registry.test.ts)
    // Cast: Zod's JSON Schema type allows boolean sub-schemas (draft 2020-12),
    // which our engine doesn't use. The test guarantees no data loss.
    inputJsonSchema: metadata.inputSchema
      ? (z.toJSONSchema(metadata.inputSchema) as ValidatedJSONSchema)
      : undefined,
    outputJsonSchema: metadata.outputSchema
      ? (z.toJSONSchema(metadata.outputSchema) as ValidatedJSONSchema)
      : undefined,
  };
}

/**
 * Registry of bundled agents compiled into Atlas.
 *
 * Derived automatically from the bundledAgents array. Adding an agent to the
 * array automatically includes it in this registry.
 *
 * @example
 * ```typescript
 * const slackAgent = bundledAgentsRegistry["slack"];
 * console.log(slackAgent.examples); // ["Post update to #general: ..."]
 * console.log(slackAgent.outputJsonSchema); // JSON Schema from SlackOutputSchema
 * ```
 */
export const bundledAgentsRegistry = Object.fromEntries(
  bundledAgents.map((agent) => [agent.metadata.id, deriveRegistryEntry(agent)]),
) as Record<string, ReturnType<typeof deriveRegistryEntry>>;

/**
 * Type of a registry entry, inferred from the derived registry.
 */
export type BundledAgentRegistryEntry = (typeof bundledAgentsRegistry)[string];
