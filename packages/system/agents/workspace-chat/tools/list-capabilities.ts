import type { AtlasTools, LinkCredentialRef } from "@atlas/agent-sdk";
import {
  type BundledAgentConfigField,
  bundledAgentsRegistry,
  discoverableBundledAgents,
} from "@atlas/bundled-agents";
import type { WorkspaceConfig } from "@atlas/config";
import {
  discoverMCPServers,
  type LinkSummary,
  type MCPServerCandidate,
} from "@atlas/core/mcp-registry/discovery";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

const ListCapabilitiesInput = z.object({
  workspaceId: z
    .string()
    .min(1)
    .optional()
    .describe("Workspace to inspect. Defaults to the current session's workspace."),
});

const BundledCapabilitySchema = z.object({
  kind: z.literal("bundled"),
  id: z.string(),
  description: z.string(),
  examples: z.array(z.string()),
  constraints: z.string().optional(),
  requiresConfig: z.array(z.string()),
});

const McpEnabledCapabilitySchema = z.object({
  kind: z.literal("mcp_enabled"),
  id: z.string(),
  description: z.string(),
  requiresConfig: z.array(z.string()),
});

const McpAvailableCapabilitySchema = z.object({
  kind: z.literal("mcp_available"),
  id: z.string(),
  description: z.string(),
  provider: z.string(),
  requiresConfig: z.array(z.string()),
});

const CapabilitySchema = z.discriminatedUnion("kind", [
  BundledCapabilitySchema,
  McpEnabledCapabilitySchema,
  McpAvailableCapabilitySchema,
]);

export type Capability = z.infer<typeof CapabilitySchema>;

const ListCapabilitiesSuccessSchema = z.object({ capabilities: z.array(CapabilitySchema) });

const ListCapabilitiesErrorSchema = z.object({
  error: z.string(),
  code: z.literal("not_found").optional(),
});

export const ListCapabilitiesResultSchema = z.union([
  ListCapabilitiesSuccessSchema,
  ListCapabilitiesErrorSchema,
]);

export type ListCapabilitiesSuccess = z.infer<typeof ListCapabilitiesSuccessSchema>;
export type ListCapabilitiesError = z.infer<typeof ListCapabilitiesErrorSchema>;
export type ListCapabilitiesResult = z.infer<typeof ListCapabilitiesResultSchema>;

const KIND_ORDER: Record<Capability["kind"], number> = {
  bundled: 0,
  mcp_enabled: 1,
  mcp_available: 2,
};

function bundledRequiresConfig(fields: BundledAgentConfigField[]): string[] {
  return fields.map((f) => (f.from === "env" ? f.key : f.envKey));
}

function isLinkCredentialRef(value: string | LinkCredentialRef): value is LinkCredentialRef {
  return typeof value !== "string" && "from" in value && value.from === "link";
}

function mcpRequiresConfig(candidate: MCPServerCandidate): string[] {
  if (candidate.configured) return [];
  const env = candidate.mergedConfig.env;
  if (!env) return [];

  const keys: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      keys.push(key);
    } else if (isLinkCredentialRef(value)) {
      keys.push(key);
    }
  }
  return keys;
}

function mcpProvider(candidate: MCPServerCandidate): string {
  const env = candidate.mergedConfig.env;
  if (env) {
    for (const value of Object.values(env)) {
      if (isLinkCredentialRef(value) && value.provider) {
        return value.provider;
      }
    }
  }
  return candidate.metadata.source;
}

function buildBundledCapabilities(): Capability[] {
  return discoverableBundledAgents.map((agent) => {
    const registryEntry = bundledAgentsRegistry[agent.metadata.id];
    const requiresConfig = registryEntry ? bundledRequiresConfig(registryEntry.requiredConfig) : [];

    const base = {
      kind: "bundled" as const,
      id: agent.metadata.id,
      description: agent.metadata.description,
      examples: agent.metadata.expertise.examples,
      requiresConfig,
    };

    return BundledCapabilitySchema.parse(
      agent.metadata.constraints !== undefined
        ? { ...base, constraints: agent.metadata.constraints }
        : base,
    );
  });
}

function buildMCPCapabilities(
  candidates: MCPServerCandidate[],
  workspaceConfig: WorkspaceConfig | undefined,
): Capability[] {
  const enabledIds = new Set(Object.keys(workspaceConfig?.tools?.mcp?.servers ?? {}));

  return candidates.map((c) => {
    const description = c.metadata.description ?? c.metadata.name;
    const requiresConfig = mcpRequiresConfig(c);

    if (enabledIds.has(c.metadata.id)) {
      return McpEnabledCapabilitySchema.parse({
        kind: "mcp_enabled",
        id: c.metadata.id,
        description,
        requiresConfig,
      });
    }

    return McpAvailableCapabilitySchema.parse({
      kind: "mcp_available",
      id: c.metadata.id,
      description,
      provider: mcpProvider(c),
      requiresConfig,
    });
  });
}

function sortCapabilities(capabilities: Capability[]): Capability[] {
  return [...capabilities].sort((a, b) => {
    const kindDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return kindDiff !== 0 ? kindDiff : a.id.localeCompare(b.id);
  });
}

function isWorkspaceNotFound(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /404|not found|workspace.*not.*found/i.test(message);
}

/**
 * Build the `list_capabilities` tool for workspace chat.
 *
 * Single discovery surface returning every capability the workspace can use:
 * bundled atlas agents, enabled MCP servers, and available MCP servers in the
 * platform catalog. Output is sorted bundled-first, alphabetical within each
 * kind, so the LLM scans top-down and picks the simplest match.
 */
export function createListCapabilitiesTool(
  workspaceId: string,
  workspaceConfig: WorkspaceConfig | undefined,
  linkSummary: LinkSummary | undefined,
  logger: Logger,
): AtlasTools {
  return {
    list_capabilities: tool({
      description:
        "List every capability available to this workspace: bundled atlas agents (web, email, " +
        "slack, gh, etc.), enabled MCP servers, and MCP servers in the platform catalog. " +
        "Output is bundled-first, alphabetical within each kind. Scan top-down and pick the " +
        "first match — bundled agents are zero-config and should be your default when the " +
        "domain fits. Each entry carries `requiresConfig` (env keys / credentials still needed " +
        "to function); bundled entries also carry `examples` and `constraints`.",
      inputSchema: ListCapabilitiesInput,
      execute: async ({
        workspaceId: overrideId,
      }): Promise<ListCapabilitiesSuccess | ListCapabilitiesError> => {
        const targetWorkspaceId = overrideId ?? workspaceId;

        try {
          const candidates = await discoverMCPServers(
            targetWorkspaceId,
            workspaceConfig,
            linkSummary,
          );

          const bundled = buildBundledCapabilities();
          const mcp = buildMCPCapabilities(candidates, workspaceConfig);
          const capabilities = sortCapabilities([...bundled, ...mcp]);

          logger.info("list_capabilities succeeded", {
            workspaceId: targetWorkspaceId,
            bundledCount: bundled.length,
            mcpEnabledCount: mcp.filter((c) => c.kind === "mcp_enabled").length,
            mcpAvailableCount: mcp.filter((c) => c.kind === "mcp_available").length,
          });

          return { capabilities };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isWorkspaceNotFound(err)) {
            logger.info("list_capabilities: workspace not found", {
              workspaceId: targetWorkspaceId,
              error: message,
            });
            return { error: `Workspace "${targetWorkspaceId}" not found.`, code: "not_found" };
          }
          logger.warn("list_capabilities failed", {
            workspaceId: targetWorkspaceId,
            error: message,
          });
          return { error: `list_capabilities failed: ${message}` };
        }
      },
    }),
  };
}
