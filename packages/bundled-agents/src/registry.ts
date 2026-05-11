import type { AgentEnvironmentConfig, AtlasAgent } from "@atlas/agent-sdk";
import type { ValidatedJSONSchema } from "@atlas/schemas/json-schema";
import { z } from "zod";
import { bbAgent } from "./bb/agent.ts";
import { claudeCodeAgent } from "./claude-code/agent.ts";
import { fathomGetTranscriptAgent } from "./fathom-ai/get-transcript.ts";
import { ghAgent } from "./gh/agent.ts";
import { hubspotAgent } from "./hubspot/index.ts";
import { imageGenerationAgent } from "./image-generation/agent.ts";
import { jiraAgent } from "./jira/agent.ts";
import { knowledgeHybridAgent } from "./knowledge/agent.ts";
import { slackCommunicatorAgent } from "./slack/communicator.ts";
import { summaryAgent } from "./summary.ts";
import { webAgent } from "./web/index.ts";

/**
 * All bundled agents in the order they're registered.
 * This array is the single source of truth - adding an agent here
 * automatically includes it in the registry.
 */
export const bundledAgents: AtlasAgent[] = [
  slackCommunicatorAgent,
  webAgent,
  summaryAgent,
  fathomGetTranscriptAgent,
  claudeCodeAgent,
  ghAgent,
  bbAgent,
  jiraAgent,
  hubspotAgent,
  imageGenerationAgent,
  knowledgeHybridAgent,
];

/** Agents hidden from discovery surfaces (list_capabilities, system prompts). */
const HIDDEN_FROM_DISCOVERY = new Set(["fathom-get-transcript"]);

/** Subset of bundled agents advertised in discovery surfaces. */
export const discoverableBundledAgents = bundledAgents.filter(
  (a) => !HIDDEN_FROM_DISCOVERY.has(a.metadata.id),
);

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

/** Converts agent environment config to registry config fields. */
function toConfigFields(envConfig: AgentEnvironmentConfig["required"]): BundledAgentConfigField[] {
  if (!envConfig) return [];

  return envConfig.map((field): BundledAgentConfigField => {
    if (field.linkRef) {
      return {
        from: "link",
        envKey: field.name,
        provider: field.linkRef.provider,
        key: field.linkRef.key,
        description: field.description,
      };
    }
    return {
      from: "env",
      key: field.name,
      description: field.description,
      type: "string",
      validation: field.validation,
    };
  });
}

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

function deriveRegistryEntry(agent: AtlasAgent) {
  const { metadata, environmentConfig } = agent;

  return {
    id: metadata.id,
    name: metadata.displayName ?? metadata.id,
    description: metadata.description,
    summary: metadata.summary,
    version: metadata.version,
    examples: metadata.expertise.examples,
    requiredConfig: toConfigFields(environmentConfig?.required),
    optionalConfig: toOptionalConfigFields(environmentConfig?.optional),

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

const baseRegistry = Object.fromEntries(
  bundledAgents.map((agent) => [agent.metadata.id, deriveRegistryEntry(agent)]),
);

/**
 * Registry of bundled agents compiled into Atlas.
 *
 * Includes aliases for old agent IDs (`browser`, `research`) that now point
 * to the unified `web` agent, so existing workspace configs keep working.
 */
export const bundledAgentsRegistry = {
  ...baseRegistry,
  // Aliases: old agent IDs → unified web agent
  browser: baseRegistry["web"],
  research: baseRegistry["web"],
} as Record<string, ReturnType<typeof deriveRegistryEntry>>;

export type BundledAgentRegistryEntry = (typeof bundledAgentsRegistry)[string];
