import process from "node:process";
import type { LinkCredentialRef } from "@atlas/agent-sdk";
import { client, DetailedError, parseResult } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";

/** Minimal credential info from Link summary endpoint */
export type CredentialSummary = { id: string; provider: string; label: string; type: string };

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

async function fetchCredentialsByProvider(provider: string): Promise<CredentialSummary[]> {
  const result = await parseResult(
    client.link.v1.summary.$get({ query: { provider } }, { headers: getLinkAuthHeaders() }),
  );
  if (!result.ok) {
    throw new Error(`Failed to fetch credentials: ${result.error}`);
  }
  return result.data.credentials;
}

export async function resolveCredentialsByProvider(provider: string): Promise<CredentialSummary[]> {
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
      current instanceof LinkCredentialExpiredError
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
      let credentialId = value.id;

      // Support provider-based resolution (resolve provider to credential ID)
      if (!credentialId && value.provider) {
        const credentials = await fetchCredentialsByProvider(value.provider);
        const firstCredential = credentials.at(0);
        if (!firstCredential) {
          throw new Error(`No credentials found for provider '${value.provider}'.`);
        }
        credentialId = firstCredential.id;
        logger.debug("Resolved credential ID from provider", {
          envKey,
          provider: value.provider,
          credentialId,
        });
      }

      if (!credentialId) {
        throw new Error(
          `Credential reference for '${envKey}' requires either 'id' or 'provider' to be specified.`,
        );
      }

      const credential = await fetchLinkCredential(credentialId, logger);
      const secretValue = credential.secret[value.key];

      if (secretValue === undefined) {
        const availableKeys = Object.keys(credential.secret).join(", ");
        throw new Error(
          `Key '${value.key}' not found in credential '${credentialId}'. Available: ${availableKeys}`,
        );
      }

      if (typeof secretValue !== "string") {
        throw new Error(
          `Secret key '${value.key}' in credential '${credentialId}' must be a string.`,
        );
      }

      resolved[envKey] = secretValue;
    }
  }

  return resolved;
}
