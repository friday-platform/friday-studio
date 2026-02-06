/**
 * Credential extraction and mutation functions for workspace configuration
 *
 * Pure functions that extract and update Link credential references from workspace config.
 * Used by the frontend to display and update credentials.
 */

import type { LinkCredentialRef } from "@atlas/agent-sdk";
import { produce } from "immer";
import type { WorkspaceConfig } from "../workspace.ts";
import { type MutationResult, notFoundError, validationError } from "./types.ts";

/**
 * Represents a credential usage location in the config.
 * Path format: "mcp:{serverId}:{envVar}" or "agent:{agentId}:{envVar}"
 */
export interface CredentialUsage {
  path: string;
  credentialId?: string;
  provider?: string;
}

/**
 * Type guard to check if an env value is a LinkCredentialRef.
 */
function isLinkCredentialRef(value: unknown): value is LinkCredentialRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "from" in value &&
    (value as { from: unknown }).from === "link"
  );
}

/**
 * Extracts all credential references from a workspace configuration.
 *
 * Walks through MCP server env vars and Atlas agent env vars,
 * returning credential usages with their paths.
 *
 * @param config - Workspace configuration to extract from
 * @returns Array of credential usages found in the config
 */
export function extractCredentials(config: WorkspaceConfig): CredentialUsage[] {
  const usages: CredentialUsage[] = [];

  // Extract from MCP servers
  const servers = config.tools?.mcp?.servers ?? {};
  for (const [serverId, server] of Object.entries(servers)) {
    const env = server.env ?? {};
    for (const [envVar, value] of Object.entries(env)) {
      if (isLinkCredentialRef(value)) {
        const usage: CredentialUsage = { path: `mcp:${serverId}:${envVar}` };
        if (value.id) {
          usage.credentialId = value.id;
        }
        if (value.provider) {
          usage.provider = value.provider;
        }
        usages.push(usage);
      }
    }
  }

  // Extract from Atlas agents
  const agents = config.agents ?? {};
  for (const [agentId, agent] of Object.entries(agents)) {
    // Only Atlas agents have env with credentials
    if (agent.type !== "atlas") continue;

    const env = agent.env ?? {};
    for (const [envVar, value] of Object.entries(env)) {
      if (isLinkCredentialRef(value)) {
        const usage: CredentialUsage = { path: `agent:${agentId}:${envVar}` };
        if (value.id) {
          usage.credentialId = value.id;
        }
        if (value.provider) {
          usage.provider = value.provider;
        }
        usages.push(usage);
      }
    }
  }

  return usages;
}

type CredentialPathType = "mcp" | "agent";

interface ParsedCredentialPath {
  type: CredentialPathType;
  entityId: string;
  envVar: string;
}

/**
 * Parse a credential path into its components.
 *
 * Path format: "{type}:{entityId}:{envVar}"
 * - type: "mcp" or "agent"
 * - entityId: server ID or agent ID
 * - envVar: environment variable name
 *
 * @param path - Credential path string
 * @returns Parsed path or null if invalid format
 */
function parseCredentialPath(path: string): ParsedCredentialPath | null {
  const parts = path.split(":");
  if (parts.length !== 3) return null;

  const [type, entityId, envVar] = parts;
  if (!type || !entityId || !envVar) return null;

  if (type !== "mcp" && type !== "agent") return null;

  return { type, entityId, envVar };
}

/**
 * Updates a credential reference at the specified path.
 *
 * Swaps the credential ID while preserving the `key` field from the original ref.
 * Converts provider-based refs to id-based refs.
 *
 * @param config - Current workspace configuration
 * @param path - Credential path in format "{type}:{entityId}:{envVar}"
 * @param credentialId - New credential ID to set
 * @returns MutationResult with updated config or error
 */
export function updateCredential(
  config: WorkspaceConfig,
  path: string,
  credentialId: string,
): MutationResult<WorkspaceConfig> {
  // Parse and validate path format
  const parsed = parseCredentialPath(path);
  if (!parsed) {
    return {
      ok: false,
      error: validationError(
        "Invalid credential path format. Expected: {type}:{entityId}:{envVar} where type is 'mcp' or 'agent'",
      ),
    };
  }

  const { type, entityId, envVar } = parsed;

  let existingRef: LinkCredentialRef | undefined;

  if (type === "mcp") {
    const server = config.tools?.mcp?.servers?.[entityId];
    if (!server?.env) {
      return { ok: false, error: notFoundError(path, "credential") };
    }
    const value = server.env[envVar];
    if (isLinkCredentialRef(value)) {
      existingRef = value;
    }
  } else {
    // type === "agent"
    const agent = config.agents?.[entityId];
    if (!agent || agent.type !== "atlas" || !agent.env) {
      return { ok: false, error: notFoundError(path, "credential") };
    }
    const value = agent.env[envVar];
    if (isLinkCredentialRef(value)) {
      existingRef = value;
    }
  }

  if (!existingRef) {
    return { ok: false, error: notFoundError(path, "credential") };
  }

  const newRef: LinkCredentialRef = { from: "link", id: credentialId, key: existingRef.key };

  const value = produce(config, (draft) => {
    if (type === "mcp") {
      const server = draft.tools?.mcp?.servers?.[entityId];
      if (server?.env) {
        server.env[envVar] = newRef;
      }
    } else {
      const agent = draft.agents?.[entityId];
      if (agent && agent.type === "atlas" && agent.env) {
        agent.env[envVar] = newRef;
      }
    }
  });

  return { ok: true, value };
}
