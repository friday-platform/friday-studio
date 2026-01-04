/**
 * Environment Context Factory
 *
 * Creates functions for validating environment variables needed by agents.
 * Uses process.env for workspace-scoped variables and provides clear
 * error messages for missing requirements.
 */

import process from "node:process";
import type { AgentEnvironmentConfig } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import {
  CredentialNotFoundError,
  fetchLinkCredential,
  resolveCredentialsByProvider,
} from "../mcp-registry/credential-resolver.ts";

/**
 * Keys that LITELLM_API_KEY can substitute for.
 * When these are required but missing, LITELLM_API_KEY satisfies the requirement
 * since @atlas/llm routes through LiteLLM proxy when LITELLM_API_KEY is set.
 */
const LITELLM_SUBSTITUTABLE_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
]);

/**
 * Create an environment context validator
 */
export function createEnvironmentContext(logger: Logger) {
  return async function validateEnvironment(
    workspaceId: string,
    agentId: string,
    environmentConfig?: AgentEnvironmentConfig,
  ): Promise<Record<string, string>> {
    const env: Record<string, string> = {};

    // If no environment configuration, return empty context
    if (!environmentConfig) {
      logger.debug("Agent has no environment configuration", {
        operation: "environment_validation",
        workspaceId,
        agentId,
      });
      return Promise.resolve(env);
    }

    const missingRequired: string[] = [];
    const missingProviders = new Set<string>();

    // Validate required environment variables
    if (environmentConfig.required) {
      const litellmKey = process.env.LITELLM_API_KEY;

      for (const reqVar of environmentConfig.required) {
        let value = process.env[reqVar.name];
        let usedSubstitute = false;

        // Try to resolve from Link if linkRef is provided and value is missing
        if (!value && reqVar.linkRef) {
          try {
            const credentials = await resolveCredentialsByProvider(reqVar.linkRef.provider);
            const firstCredential = credentials.at(0);
            if (firstCredential) {
              const credential = await fetchLinkCredential(firstCredential.id, logger);
              const secretValue = credential.secret[reqVar.linkRef.key];

              if (typeof secretValue === "string") {
                value = secretValue;
                logger.debug("Resolved credential from Link", {
                  operation: "environment_validation",
                  workspaceId,
                  agentId,
                  variable: reqVar.name,
                  provider: reqVar.linkRef.provider,
                });
              } else if (secretValue !== undefined) {
                logger.warn("Link credential key value is not a string", {
                  operation: "environment_validation",
                  workspaceId,
                  agentId,
                  variable: reqVar.name,
                  provider: reqVar.linkRef.provider,
                  key: reqVar.linkRef.key,
                });
              }
            }
          } catch (err) {
            // CredentialNotFoundError means user hasn't connected to the provider yet.
            // This is expected - continue and mark as missing required variable.
            if (err instanceof CredentialNotFoundError) {
              logger.debug("No credentials found for provider", {
                operation: "environment_validation",
                workspaceId,
                agentId,
                variable: reqVar.name,
                provider: reqVar.linkRef.provider,
              });
              // Continue - will be caught as missing required below
            } else {
              // Other errors (refresh failed, expired, API errors) should surface immediately
              // so users understand the actual problem rather than seeing "variable not found".
              logger.error("Credential resolution failed", {
                operation: "environment_validation",
                workspaceId,
                agentId,
                variable: reqVar.name,
                provider: reqVar.linkRef.provider,
                error: err,
              });
              throw new Error(
                `Can't execute ${agentId}: Your '${reqVar.linkRef.provider}' credentials could not be loaded. ` +
                  `Please reconnect your ${reqVar.linkRef.provider} account and try again.`,
                { cause: err },
              );
            }
          }
        }

        // If primary variable is missing, check if LITELLM_API_KEY can substitute
        if (!value && litellmKey && LITELLM_SUBSTITUTABLE_KEYS.has(reqVar.name)) {
          value = litellmKey;
          usedSubstitute = true;
          logger.debug("Using LITELLM_API_KEY as substitute", {
            operation: "environment_validation",
            workspaceId,
            agentId,
            required: reqVar.name,
          });
        }

        if (value === undefined || value === "") {
          // Track Link providers separately for better error messages
          if (reqVar.linkRef) {
            missingProviders.add(reqVar.linkRef.provider);
          } else {
            missingRequired.push(reqVar.name);
          }
          continue;
        }

        // Validate against regex pattern if provided (skip validation for substitutes)
        if (reqVar.validation && !usedSubstitute) {
          let regex: RegExp;
          try {
            regex = new RegExp(reqVar.validation);
          } catch (regexError) {
            logger.error("Invalid regex pattern in environment configuration", {
              operation: "environment_validation",
              workspaceId,
              agentId,
              variable: reqVar.name,
              pattern: reqVar.validation,
              error: regexError,
            });
            throw new Error(`Invalid regex pattern for ${reqVar.name}: ${reqVar.validation}`);
          }

          if (!regex.test(value)) {
            logger.error("Environment variable failed validation", {
              operation: "environment_validation",
              workspaceId,
              agentId,
              variable: reqVar.name,
              pattern: reqVar.validation,
            });
            throw new Error(
              `Environment variable ${reqVar.name} failed validation pattern: ${reqVar.validation}`,
            );
          }
        }

        env[reqVar.name] = value;
      }
    }

    // Add optional environment variables with defaults
    if (environmentConfig.optional) {
      for (const optVar of environmentConfig.optional) {
        const value = process.env[optVar.name];
        env[optVar.name] = value ?? optVar.default ?? "";
      }
    }

    // If there are missing credentials or variables, throw detailed error
    if (missingProviders.size > 0 || missingRequired.length > 0) {
      const errorParts: string[] = [];

      // Link credentials require OAuth connection, not .env file
      if (missingProviders.size > 0) {
        const providers = [...missingProviders];
        errorParts.push(
          `Please connect your ${providers.join(", ")} account${providers.length > 1 ? "s" : ""} to continue.`,
        );
      }

      // Regular env vars need .env file
      if (missingRequired.length > 0) {
        errorParts.push(
          `Required environment variables not found: ${missingRequired.join(", ")}. Please add these to your workspace .env file.`,
        );
      }

      logger.error("Environment variable validation failed", {
        missingVariables: missingRequired,
        missingProviders: [...missingProviders],
      });
      throw new Error(
        `Can't execute ${agentId} in workspace '${workspaceId}': ${errorParts.join(" ")}`,
        {
          cause: {
            missingVariables: missingRequired,
            missingProviders: [...missingProviders],
            workspaceId,
            agentId,
          },
        },
      );
    }

    logger.info("Validated environment variables", { providedVariables: Object.keys(env).length });
    return Promise.resolve(env);
  };
}
