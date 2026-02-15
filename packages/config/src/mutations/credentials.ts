import type { LinkCredentialRef } from "@atlas/agent-sdk";
import { produce } from "immer";
import type { WorkspaceConfig } from "../workspace.ts";
import { type MutationResult, notFoundError, validationError } from "./types.ts";

/** Path format: "mcp:{serverId}:{envVar}" or "agent:{agentId}:{envVar}" */
export interface CredentialUsage {
  path: string;
  credentialId?: string;
  provider?: string;
  key: string;
}

/** Type guard for LinkCredentialRef env values. */
function isLinkCredentialRef(value: unknown): value is LinkCredentialRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "from" in value &&
    (value as { from: unknown }).from === "link"
  );
}

/** Extracts all credential references from MCP server and Atlas agent env vars. */
export function extractCredentials(config: WorkspaceConfig): CredentialUsage[] {
  const usages: CredentialUsage[] = [];

  const servers = config.tools?.mcp?.servers ?? {};
  for (const [serverId, server] of Object.entries(servers)) {
    const env = server.env ?? {};
    for (const [envVar, value] of Object.entries(env)) {
      if (isLinkCredentialRef(value)) {
        const usage: CredentialUsage = { path: `mcp:${serverId}:${envVar}`, key: value.key };
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

  const agents = config.agents ?? {};
  for (const [agentId, agent] of Object.entries(agents)) {
    if (agent.type !== "atlas") continue;

    const env = agent.env ?? {};
    for (const [envVar, value] of Object.entries(env)) {
      if (isLinkCredentialRef(value)) {
        const usage: CredentialUsage = { path: `agent:${agentId}:${envVar}`, key: value.key };
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

/** Parses "{type}:{entityId}:{envVar}" into components, or null if invalid. */
function parseCredentialPath(path: string): ParsedCredentialPath | null {
  const parts = path.split(":");
  if (parts.length !== 3) return null;

  const [type, entityId, envVar] = parts;
  if (!type || !entityId || !envVar) return null;

  if (type !== "mcp" && type !== "agent") return null;

  return { type, entityId, envVar };
}

/** Swaps the credential ID at `path`, preserving the existing `key`. */
export function updateCredential(
  config: WorkspaceConfig,
  path: string,
  credentialId: string,
  provider?: string,
): MutationResult<WorkspaceConfig> {
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

  const newRef: LinkCredentialRef = {
    from: "link",
    id: credentialId,
    ...(provider ? { provider } : {}),
    key: existingRef.key,
  };

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

/**
 * Strips user-scoped `id` fields from credential refs, keeping only `provider` and `key`.
 * Legacy id-only refs are resolved via providerMap.
 */
export function toProviderRefs(
  config: WorkspaceConfig,
  providerMap: Record<string, string>,
): WorkspaceConfig {
  return produce(config, (draft) => {
    const servers = draft.tools?.mcp?.servers ?? {};
    for (const server of Object.values(servers)) {
      if (!server.env) continue;
      for (const [envVar, value] of Object.entries(server.env)) {
        if (isLinkCredentialRef(value)) {
          server.env[envVar] = toProviderRef(value, providerMap);
        }
      }
    }

    const agents = draft.agents ?? {};
    for (const agent of Object.values(agents)) {
      if (agent.type !== "atlas") continue;
      if (!agent.env) continue;
      for (const [envVar, value] of Object.entries(agent.env)) {
        if (isLinkCredentialRef(value)) {
          agent.env[envVar] = toProviderRef(value, providerMap);
        }
      }
    }
  });
}

/** Converts a single ref to provider-based form, resolving legacy id-only refs via providerMap. */
function toProviderRef(
  ref: LinkCredentialRef,
  providerMap: Record<string, string>,
): LinkCredentialRef {
  if (ref.provider) {
    return { from: "link", provider: ref.provider, key: ref.key };
  }

  // Legacy id-only ref — must resolve via providerMap (refine guarantees id exists when no provider)
  const provider = providerMap[ref.id ?? ""];
  if (!provider) {
    throw new Error(
      `Cannot export credential: no provider found for credential ID "${ref.id}". ` +
        `Provide a providerMap entry or re-assign the credential.`,
    );
  }

  return { from: "link", provider, key: ref.key };
}

/** Adds concrete credential IDs to provider-only refs. Refs with existing `id` pass through. */
export function toIdRefs(
  config: WorkspaceConfig,
  credentialMap: Record<string, string>,
): WorkspaceConfig {
  return produce(config, (draft) => {
    const servers = draft.tools?.mcp?.servers ?? {};
    for (const server of Object.values(servers)) {
      if (!server.env) continue;
      for (const [envVar, value] of Object.entries(server.env)) {
        if (isLinkCredentialRef(value)) {
          server.env[envVar] = toIdRef(value, credentialMap);
        }
      }
    }

    const agents = draft.agents ?? {};
    for (const agent of Object.values(agents)) {
      if (agent.type !== "atlas") continue;
      if (!agent.env) continue;
      for (const [envVar, value] of Object.entries(agent.env)) {
        if (isLinkCredentialRef(value)) {
          agent.env[envVar] = toIdRef(value, credentialMap);
        }
      }
    }
  });
}

/** Adds `id` from credentialMap to provider-only refs. Refs with existing `id` pass through. */
function toIdRef(ref: LinkCredentialRef, credentialMap: Record<string, string>): LinkCredentialRef {
  if (ref.id) {
    return ref;
  }

  // Refine guarantees provider exists when no id
  const id = credentialMap[ref.provider ?? ""];
  if (!id) {
    throw new Error(
      `Cannot import credential: no credential ID found for provider "${ref.provider}". ` +
        `Provide a credentialMap entry or connect the integration first.`,
    );
  }

  return { from: "link", id, provider: ref.provider, key: ref.key };
}
