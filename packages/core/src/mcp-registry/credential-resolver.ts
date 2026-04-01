import process from "node:process";
import type { LinkCredentialRef } from "@atlas/agent-sdk";
import { client, DetailedError, parseResult } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";

/** Credential info from Link summary endpoint */
export type CredentialSummary = {
  id: string;
  provider: string;
  label: string;
  type: string;
  displayName: string | null;
  userIdentifier: string | null;
  isDefault: boolean;
};

/** Full credential with secret from Link API */
export type Credential = {
  id: string;
  provider: string;
  type: string;
  secret: Record<string, unknown>;
};

export class CredentialNotFoundError extends Error {
  constructor(public readonly provider: string) {
    super(`No credentials found for provider '${provider}'`);
    this.name = "CredentialNotFoundError";
  }
}

/** Error thrown when a provider is not registered in the Link provider registry */
export class InvalidProviderError extends Error {
  constructor(public readonly provider: string) {
    super(`Provider '${provider}' is not a registered provider`);
    this.name = "InvalidProviderError";
  }
}

/** Error thrown when a specific credential ID is not found in Link (404) */
export class LinkCredentialNotFoundError extends Error {
  constructor(
    public readonly credentialId: string,
    public readonly serverName?: string,
  ) {
    const integration = serverName ? `'${serverName}'` : "this integration";
    super(
      `The credential for ${integration} was deleted or revoked. Reconnect the integration to continue.`,
    );
    this.name = "LinkCredentialNotFoundError";
  }
}

/** Error thrown when multiple credentials exist for a provider but none is marked as default */
export class NoDefaultCredentialError extends Error {
  constructor(public readonly provider: string) {
    super(`No default credential set for ${provider}. Go to Settings > Connections to pick one.`);
    this.name = "NoDefaultCredentialError";
  }
}

/** Error thrown when a credential exists but is expired or its refresh has failed */
export class LinkCredentialExpiredError extends Error {
  constructor(
    public readonly credentialId: string,
    public readonly status: "expired_no_refresh" | "refresh_failed",
    public readonly serverName?: string,
  ) {
    const integration = serverName ? `'${serverName}'` : "this integration";
    const action = status === "refresh_failed" ? "could not be refreshed" : "has expired";
    super(`The credential for ${integration} ${action}. Reconnect the integration to continue.`);
    this.name = "LinkCredentialExpiredError";
  }
}

/** Build auth headers for Link API calls. Returns empty object in dev mode. */
function getLinkAuthHeaders(): Record<string, string> {
  if (process.env.LINK_DEV_MODE === "true") return {};

  const atlasKey = process.env.ATLAS_KEY;
  if (!atlasKey) {
    throw new Error(
      "ATLAS_KEY is required for Link authentication in production mode. " +
        "Set LINK_DEV_MODE=true for development, or ensure ATLAS_KEY is available.",
    );
  }
  return { Authorization: `Bearer ${atlasKey}` };
}

/**
 * Check for an unwired slack-app credential via Link's mapping table.
 * Returns the credential/app info if one exists, null otherwise.
 */
export async function resolveUnwiredSlackApp(): Promise<{
  credentialId: string;
  appId: string;
} | null> {
  const result = await parseResult(
    client.link.internal.v1["slack-apps"].unwired.$get({}, { headers: getLinkAuthHeaders() }),
  );

  if (!result.ok) {
    if (result.error instanceof DetailedError && result.error.statusCode === 404) {
      return null;
    }
    throw new Error(`Failed to check for unwired slack app: ${result.error}`);
  }

  return { credentialId: result.data.credential_id, appId: result.data.app_id };
}

/**
 * Resolve the slack-app credential already wired to a specific workspace.
 * Returns the credential/app info if wired, null otherwise.
 */
export async function resolveSlackAppByWorkspace(
  workspaceId: string,
): Promise<{ credentialId: string; appId: string } | null> {
  const result = await parseResult(
    client.link.internal.v1["slack-apps"]["by-workspace"][":workspace_id"].$get(
      { param: { workspace_id: workspaceId } },
      { headers: getLinkAuthHeaders() },
    ),
  );

  if (!result.ok) {
    if (result.error instanceof DetailedError && result.error.statusCode === 404) {
      return null;
    }
    throw new Error(`Failed to resolve slack-app for workspace '${workspaceId}': ${result.error}`);
  }

  return { credentialId: result.data.credential_id, appId: result.data.app_id };
}

export async function resolveCredentialsByProvider(
  provider: string,
  opts?: { workspaceId?: string },
): Promise<CredentialSummary[]> {
  // slack-app credentials are per-workspace — resolve via workspace mapping
  // instead of the generic summary endpoint.
  if (provider === "slack-app") {
    return resolveSlackAppCredentials(opts?.workspaceId);
  }

  const result = await parseResult(
    client.link.v1.summary.$get({ query: { provider } }, { headers: getLinkAuthHeaders() }),
  );
  if (!result.ok) {
    throw new Error(`Failed to fetch credentials for provider '${provider}': ${result.error}`);
  }

  const { credentials, providers } = result.data;
  if (credentials.length === 0) {
    const isKnownProvider = providers.some((p) => p.id === provider);
    if (!isKnownProvider) throw new InvalidProviderError(provider);
    throw new CredentialNotFoundError(provider);
  }
  return credentials;
}

/**
 * Resolve slack-app credential. Resolution order:
 * 1. If workspaceId provided, check for a bot already wired to this workspace
 * 2. Check for an unwired bot (available for wiring by the workspace create flow)
 * 3. No credential available — throw
 */
async function resolveSlackAppCredentials(workspaceId?: string): Promise<CredentialSummary[]> {
  // Workspace exists — check wired bot first
  if (workspaceId) {
    const wired = await resolveSlackAppByWorkspace(workspaceId);
    if (wired) {
      return [toSlackAppSummary(wired.credentialId)];
    }
  }

  // Check for an unwired bot (build-time: will be wired by tryAutoWireSlackApp)
  const unwired = await resolveUnwiredSlackApp();
  if (unwired) {
    return [toSlackAppSummary(unwired.credentialId)];
  }

  throw new CredentialNotFoundError("slack-app");
}

function toSlackAppSummary(credentialId: string): CredentialSummary {
  return {
    id: credentialId,
    provider: "slack-app",
    label: "",
    type: "oauth",
    displayName: null,
    userIdentifier: null,
    isDefault: false,
  };
}

/**
 * Fetches the default credential for a provider from Link service.
 * Calls GET /internal/v1/credentials/default/:provider.
 * Throws NoDefaultCredentialError if no default is set (404).
 */
async function fetchDefaultCredential(provider: string, logger: Logger): Promise<Credential> {
  logger.debug("Fetching default credential from Link", { provider });

  const result = await parseResult(
    client.link.internal.v1.credentials.default[":provider"].$get(
      { param: { provider } },
      { headers: getLinkAuthHeaders() },
    ),
  );

  if (!result.ok) {
    if (result.error instanceof DetailedError && result.error.statusCode === 404) {
      throw new NoDefaultCredentialError(provider);
    }
    throw new Error(
      `Failed to fetch default credential for provider '${provider}' from Link service: ${result.error}`,
    );
  }

  const { credential, status } = result.data;

  if (status === "expired_no_refresh") {
    throw new LinkCredentialExpiredError(credential.id, "expired_no_refresh");
  }

  if (status === "refresh_failed") {
    throw new LinkCredentialExpiredError(credential.id, "refresh_failed");
  }

  return credential;
}

/**
 * Fetches a credential from Link service.
 * Uses ATLAS_KEY (obtained from Cypher) for authentication in production mode.
 * In dev mode (LINK_DEV_MODE=true), no authentication is required.
 */
export async function fetchLinkCredential(
  credentialId: string,
  logger: Logger,
): Promise<Credential> {
  logger.debug("Fetching credential from Link", { credentialId });

  const result = await parseResult(
    client.link.internal.v1.credentials[":id"].$get(
      { param: { id: credentialId } },
      { headers: getLinkAuthHeaders() },
    ),
  );

  if (!result.ok) {
    // Check for 404 specifically - credential was deleted or never existed
    if (result.error instanceof DetailedError && result.error.statusCode === 404) {
      throw new LinkCredentialNotFoundError(credentialId);
    }
    throw new Error(
      `Failed to fetch credential '${credentialId}' from Link service: ${result.error}`,
    );
  }

  const { credential, status } = result.data;

  if (status === "expired_no_refresh") {
    throw new LinkCredentialExpiredError(credentialId, "expired_no_refresh");
  }

  if (status === "refresh_failed") {
    throw new LinkCredentialExpiredError(credentialId, "refresh_failed");
  }

  return credential;
}

/** Check if an error (or any error in its `.cause` chain) is an unusable credential error. */
export function hasUnusableCredentialCause(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (
      current instanceof LinkCredentialNotFoundError ||
      current instanceof LinkCredentialExpiredError ||
      current instanceof NoDefaultCredentialError
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Resolves environment variable values, fetching Link credentials as needed
 * @param env Environment variable configuration (strings or Link credential refs)
 * @param logger Logger instance for debug output
 * @returns Resolved environment variables as strings
 */
export async function resolveEnvValues(
  env: Record<string, string | LinkCredentialRef>,
  logger: Logger,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [envKey, value] of Object.entries(env)) {
    if (typeof value === "string") {
      if (value === "auto" || value === "from_environment") {
        const envValue = process.env[envKey];
        if (!envValue) {
          throw new Error(`Required environment variable '${envKey}' not found.`);
        }
        resolved[envKey] = envValue;
      } else {
        resolved[envKey] = value;
      }
    } else if (value.from === "link") {
      let credential: Credential;

      if (value.id) {
        // Explicit credential ID — fetch by ID directly
        credential = await fetchLinkCredential(value.id, logger);
      } else if (value.provider) {
        // Provider-only ref — fetch default credential for provider
        credential = await fetchDefaultCredential(value.provider, logger);
        logger.debug("Resolved default credential from provider", {
          envKey,
          provider: value.provider,
          credentialId: credential.id,
        });
      } else {
        throw new Error(
          `Credential reference for '${envKey}' requires either 'id' or 'provider' to be specified.`,
        );
      }

      const secretValue = credential.secret[value.key];

      if (secretValue === undefined) {
        const availableKeys = Object.keys(credential.secret).join(", ");
        throw new Error(
          `Key '${value.key}' not found in credential '${credential.id}'. Available: ${availableKeys}`,
        );
      }

      if (typeof secretValue !== "string") {
        throw new Error(
          `Secret key '${value.key}' in credential '${credential.id}' must be a string.`,
        );
      }

      resolved[envKey] = secretValue;
    }
  }

  return resolved;
}
