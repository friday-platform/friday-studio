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

    // Load Link private key if needed (for credential resolution)
    let linkPrivateKey: string | null = null;
    const devMode = process.env.LINK_DEV_MODE === "true";

    if (!devMode) {
      const keyFile = process.env.ATLAS_JWT_PRIVATE_KEY_FILE;
      if (keyFile) {
        try {
          const { readFileSync } = await import("node:fs");
          linkPrivateKey = readFileSync(keyFile, "utf-8").trim();
        } catch (error) {
          logger.warn("Failed to load Link JWT private key", {
            operation: "environment_validation",
            keyFile,
            error,
          });
        }
      }
    }

    // Validate required environment variables
    if (environmentConfig.required) {
      const litellmKey = process.env.LITELLM_API_KEY;

      for (const reqVar of environmentConfig.required) {
        let value = process.env[reqVar.name];
        let usedSubstitute = false;

        // Try to resolve from Link if linkRef is provided and value is missing
        if (!value && reqVar.linkRef) {
          try {
            const userId = process.env.ATLAS_USER_ID ?? "dev";
            const credentials = await resolveCredentialsByProvider(reqVar.linkRef.provider, userId);
            if (credentials.length > 0) {
              const credential = await fetchLinkCredential(
                credentials[0]!.id,
                linkPrivateKey,
                logger,
              );
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
            logger.debug("Failed to resolve Link credential", {
              operation: "environment_validation",
              workspaceId,
              agentId,
              variable: reqVar.name,
              provider: reqVar.linkRef.provider,
              error: err,
            });
            // Continue - will be caught as missing required below if still undefined
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
          missingRequired.push(reqVar.name);
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

    // If there are missing required variables, throw detailed error
    if (missingRequired.length > 0) {
      const error = new Error(
        `Can't execute ${agentId} in workspace '${workspaceId}': Required environment variables not found ${missingRequired.join(
          ", ",
        )}. Please add these variables to your workspace .env file.`,
        { cause: { missingVariables: missingRequired, workspaceId, agentId } },
      );

      logger.error("Environment variable validation failed", { missingVariables: missingRequired });
      throw error;
    }

    logger.info("Validated environment variables", { providedVariables: Object.keys(env).length });
    return Promise.resolve(env);
  };
}
