import process from "node:process";
import type { LinkCredentialRef } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";
import * as jose from "jose";

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

async function fetchCredentialsByProvider(
  userId: string,
  provider: string,
): Promise<CredentialSummary[]> {
  const result = await parseResult(
    client.link.v1.summary.$get(
      { query: { provider } },
      { headers: { "X-Atlas-User-ID": userId } },
    ),
  );
  if (!result.ok) {
    throw new Error(`Failed to fetch credentials: ${result.error}`);
  }
  return result.data.credentials;
}

export async function resolveCredentialsByProvider(
  provider: string,
  userId: string,
): Promise<CredentialSummary[]> {
  const credentials = await fetchCredentialsByProvider(userId, provider);

  if (credentials.length === 0) throw new CredentialNotFoundError(provider);
  return credentials;
}

/**
 * Signs a JWT for authenticating with Link service
 * @param userId User ID to include in sub claim
 * @param privateKeyPem PEM-encoded RSA private key
 * @returns Signed JWT token
 */
export async function signLinkJWT(userId: string, privateKeyPem: string): Promise<string> {
  const privateKey = await jose.importPKCS8(privateKeyPem, "RS256");
  const now = Math.floor(Date.now() / 1000);

  return await new jose.SignJWT({ user_metadata: { tempest_user_id: userId } })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("atlas-daemon")
    .setSubject(userId)
    .setAudience("link-service")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

/**
 * Fetches a credential from Link service
 * @param credentialId Link credential ID
 * @param linkPrivateKey PEM-encoded RSA private key (null in dev mode)
 * @param logger Logger instance for debug output
 * @returns Credential with secret
 */
export async function fetchLinkCredential(
  credentialId: string,
  linkPrivateKey: string | null,
  logger: Logger,
): Promise<Credential> {
  const userId = process.env.ATLAS_USER_ID ?? "dev";
  const devMode = process.env.LINK_DEV_MODE === "true";

  logger.debug("Fetching credential from Link", { credentialId, userId, devMode });

  const headers: Record<string, string> = {};

  if (!devMode) {
    if (!linkPrivateKey) {
      throw new Error(
        "ATLAS_JWT_PRIVATE_KEY_FILE is required for Link authentication in production mode. " +
          "Set LINK_DEV_MODE=true for development, or configure JWT keys for production.",
      );
    }

    const jwt = await signLinkJWT(userId, linkPrivateKey);
    headers.Authorization = `Bearer ${jwt}`;
  }

  const result = await parseResult(
    client.link.internal.v1.credentials[":id"].$get({ param: { id: credentialId } }, { headers }),
  );

  if (!result.ok) {
    throw new Error(
      `Failed to fetch credential '${credentialId}' from Link service: ${result.error}`,
    );
  }

  const { credential, status } = result.data;

  if (status === "expired_no_refresh") {
    throw new Error(`Credential '${credentialId}' has expired and no refresh token is available.`);
  }

  if (status === "refresh_failed") {
    throw new Error(`Credential '${credentialId}' refresh failed.`);
  }

  return credential;
}

export interface ResolveEnvOptions {
  linkPrivateKey: string | null;
  logger: Logger;
}

/**
 * Resolves environment variable values, fetching Link credentials as needed
 * @param env Environment variable configuration (strings or Link credential refs)
 * @param options Resolution options (linkPrivateKey, logger)
 * @returns Resolved environment variables as strings
 */
export async function resolveEnvValues(
  env: Record<string, string | LinkCredentialRef>,
  options: ResolveEnvOptions,
): Promise<Record<string, string>> {
  const { linkPrivateKey, logger } = options;
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
        const userId = process.env.ATLAS_USER_ID ?? "dev";
        const credentials = await fetchCredentialsByProvider(userId, value.provider);
        if (credentials.length === 0) {
          throw new Error(`No credentials found for provider '${value.provider}'.`);
        }
        credentialId = credentials[0]!.id;
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

      const credential = await fetchLinkCredential(credentialId, linkPrivateKey, logger);
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
