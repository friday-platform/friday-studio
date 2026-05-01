import process from "node:process";
import type { BundledAgentConfigField } from "@atlas/bundled-agents/registry";
import type { MCPServerConfig } from "@atlas/config";
import { z } from "zod";
import {
  CredentialNotFoundError,
  NoDefaultCredentialError,
  resolveCredentialsByProvider,
} from "./credential-resolver.ts";
import type { RequiredConfigField } from "./schemas.ts";

/**
 * Missing field identified by validation
 */
const MissingFieldSchema = z.object({
  field: z.string().describe("Name of the missing field"),
  reason: z.string().describe("Why this field is missing or insufficient"),
});

export type MissingField = z.infer<typeof MissingFieldSchema>;

/**
 * Successfully resolved credential(s)
 */
const ResolvedCredentialSchema = z.object({
  field: z.string().describe("Configuration field key"),
  provider: z.string().describe("Provider name"),
  credentialId: z.string().describe("First matching credential ID"),
  key: z.string().describe("Secret key within credential.secret (e.g. access_token)"),
  label: z.string().optional().describe("Account display name for UI (e.g., 'tempestteam')"),
});

export type ResolvedCredential = z.infer<typeof ResolvedCredentialSchema>;

/**
 * Unified config field type (works with both bundled agents and MCP servers)
 */
type ConfigField = BundledAgentConfigField | RequiredConfigField;

/**
 * Result of credential resolution validation
 */
export interface ValidationResult {
  missingCredentials: MissingField[];
  resolvedCredentials: ResolvedCredential[];
}

/**
 * Validates that all required configuration fields are available in the system environment.
 *
 * For bundled agents with `from: "link"`: resolves Link credential references by provider.
 * For bundled agents without Link refs: validates environment variables only.
 * For MCP servers with configTemplate: resolves Link credential references by provider.
 *
 * Link credential resolution uses FRIDAY_KEY from environment for authentication.
 * The user ID is extracted from the JWT by the Link service.
 *
 * @param requiredConfig - Required configuration fields from matched integration
 * @param configTemplate - Optional MCP server config template with env definitions
 * @returns Validation result with missing and resolved credentials
 */
export async function validateRequiredFields(
  requiredConfig: ConfigField[],
  configTemplate?: MCPServerConfig,
): Promise<ValidationResult> {
  const missingCredentials: MissingField[] = [];
  const resolvedCredentials: ResolvedCredential[] = [];

  // No required config = nothing to validate
  if (requiredConfig.length === 0) {
    return { missingCredentials, resolvedCredentials };
  }

  // Without configTemplate, check for Link credential refs or fall back to env var validation
  if (!configTemplate) {
    for (const field of requiredConfig) {
      // Check for Link credential reference (from: "link" pattern)
      // Schema: { from: "link", envKey, provider, key }
      // - envKey: env var name to expose
      // - provider: Link provider for credential lookup
      // - key: secret key within credential.secret
      const hasFromLink = "from" in field && field.from === "link" && "provider" in field;

      if (hasFromLink) {
        // from: "link" pattern (bundled agent registry config)
        const linkField = field as { provider: string; key: string; envKey: string };
        try {
          const credentials = await resolveCredentialsByProvider(linkField.provider);
          const defaultCred = credentials.find((c) => c.isDefault);
          if (!defaultCred) {
            throw new NoDefaultCredentialError(linkField.provider);
          }
          resolvedCredentials.push({
            field: linkField.envKey,
            provider: linkField.provider,
            credentialId: defaultCred.id,
            key: linkField.key,
            label: defaultCred.label || undefined,
          });
        } catch (error) {
          if (error instanceof CredentialNotFoundError) {
            missingCredentials.push({
              field: linkField.envKey,
              reason: `No credentials found for provider '${linkField.provider}'`,
            });
          } else if (error instanceof NoDefaultCredentialError) {
            missingCredentials.push({
              field: linkField.envKey,
              reason: `No default credential set for provider '${linkField.provider}'`,
            });
          } else {
            throw error;
          }
        }
      } else {
        // No Link ref, validate environment variable
        const envValue = process.env[field.key];
        if (!envValue) {
          missingCredentials.push({
            field: field.key,
            reason: `Environment variable ${field.key} is not set. ${field.description}`,
          });
        }
      }
    }
    return { missingCredentials, resolvedCredentials };
  }

  // With configTemplate, validate each field and resolve Link credentials
  for (const field of requiredConfig) {
    const envDef = configTemplate.env?.[field.key];

    // Field not in template = registry misconfiguration
    if (envDef === undefined) {
      throw new Error(
        `Registry misconfiguration: required field '${field.key}' not found in configTemplate.env`,
      );
    }

    // String value = direct env var, skip validation (runtime will handle)
    if (typeof envDef === "string") {
      continue;
    }

    // Link credential reference
    if (envDef.from === "link") {
      // Already resolved by ID = skip
      if (envDef.id) {
        continue;
      }

      // Resolve by provider — check that a default credential exists
      if (envDef.provider) {
        try {
          const credentials = await resolveCredentialsByProvider(envDef.provider);
          const defaultCred = credentials.find((c) => c.isDefault);
          if (!defaultCred) {
            throw new NoDefaultCredentialError(envDef.provider);
          }
          resolvedCredentials.push({
            field: field.key,
            provider: envDef.provider,
            credentialId: defaultCred.id,
            key: envDef.key,
            label: defaultCred.label || undefined,
          });
        } catch (error) {
          if (error instanceof CredentialNotFoundError) {
            missingCredentials.push({
              field: field.key,
              reason: `No credentials found for provider '${error.provider}'`,
            });
          } else if (error instanceof NoDefaultCredentialError) {
            missingCredentials.push({
              field: field.key,
              reason: `No default credential set for provider '${error.provider}'`,
            });
          } else {
            throw error;
          }
        }
      }
    }
  }

  return { missingCredentials, resolvedCredentials };
}
