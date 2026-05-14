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
    super(`No default credential set for ${provider}. Call connect_service to connect one.`);
    this.name = "NoDefaultCredentialError";
  }
}

/** Error thrown when a credential exists but is expired or its refresh has failed.
 *  Message is Link's `error` field verbatim — we don't rewrite it. */
export class LinkCredentialExpiredError extends Error {
  constructor(
    public readonly credentialId: string,
    public readonly status: "expired_no_refresh" | "refresh_failed",
    public readonly linkError: string,
    public readonly serverName?: string,
  ) {
    super(linkError);
    this.name = "LinkCredentialExpiredError";
  }
}

/**
 * Error thrown when a credential is temporarily unavailable — typically
 * because a refresh failed transiently and the caller should treat the
 * credential as "try again in a moment" rather than "reconnect now".
 * Message is Link's `error` field verbatim — we don't rewrite it.
 */
export class LinkCredentialUnavailableError extends Error {
  readonly credentialId: string;
  readonly serverName?: string;
  readonly provider?: string;
  readonly linkError: string;

  constructor(input: {
    credentialId: string;
    linkError: string;
    serverName?: string;
    provider?: string;
  }) {
    super(input.linkError);
    this.name = "LinkCredentialUnavailableError";
    this.credentialId = input.credentialId;
    this.serverName = input.serverName;
    this.provider = input.provider;
    this.linkError = input.linkError;
  }
}

/** Build auth headers for Link API calls. Returns empty object in dev mode. */
function getLinkAuthHeaders(): Record<string, string> {
  if (process.env.LINK_DEV_MODE === "true") return {};

  const atlasKey = process.env.FRIDAY_KEY;
  if (!atlasKey) {
    throw new Error(
      "FRIDAY_KEY is required for Link authentication in production mode. " +
        "Set LINK_DEV_MODE=true for development, or ensure FRIDAY_KEY is available.",
    );
  }
  return { Authorization: `Bearer ${atlasKey}` };
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
  // Link returns the technical reason in `error` for failure statuses
  // (e.g. "transient refresh failure (network): tcp connect error: Connection refused").
  // Pass it through verbatim — no translation, no polishing.
  const linkError =
    "error" in result.data && typeof result.data.error === "string" ? result.data.error : status;

  if (status === "expired_no_refresh") {
    throw new LinkCredentialExpiredError(credential.id, "expired_no_refresh", linkError);
  }

  if (status === "refresh_failed") {
    throw new LinkCredentialExpiredError(credential.id, "refresh_failed", linkError);
  }

  if (status === "refresh_unavailable") {
    throw new LinkCredentialUnavailableError({ credentialId: credential.id, linkError });
  }

  return credential;
}

/**
 * Fetches a credential from Link service.
 * Uses FRIDAY_KEY (obtained from Cypher) for authentication in production mode.
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
  const linkError =
    "error" in result.data && typeof result.data.error === "string" ? result.data.error : status;

  if (status === "expired_no_refresh") {
    throw new LinkCredentialExpiredError(credentialId, "expired_no_refresh", linkError);
  }

  if (status === "refresh_failed") {
    throw new LinkCredentialExpiredError(credentialId, "refresh_failed", linkError);
  }

  if (status === "refresh_unavailable") {
    throw new LinkCredentialUnavailableError({ credentialId, linkError });
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
 * Read an ambient env var by name, honoring the workspace `.env` overlay.
 *
 * Precedence is the one rule every spawn site shares: a per-workspace `.env`
 * value takes precedence over the daemon's `process.env`. Defined once here so
 * `resolveEnvValues` and the agent-context environment validator can't drift.
 */
export function readEnvVar(key: string, overlay?: Record<string, string>): string | undefined {
  return overlay?.[key] ?? process.env[key];
}

/**
 * Resolves environment variable values, fetching Link credentials as needed
 * @param env Environment variable configuration (strings or Link credential refs)
 * @param logger Logger instance for debug output
 * @param overlay Workspace `.env` overlay — `auto`/`from_environment` entries
 *   resolve from here before falling back to `process.env`
 * @returns Resolved environment variables as strings
 */
export async function resolveEnvValues(
  env: Record<string, string | LinkCredentialRef>,
  logger: Logger,
  overlay?: Record<string, string>,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [envKey, value] of Object.entries(env)) {
    if (typeof value === "string") {
      if (value === "auto" || value === "from_environment") {
        const envValue = readEnvVar(envKey, overlay);
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
