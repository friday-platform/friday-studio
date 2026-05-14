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
import { UserConfigurationError } from "../errors/user-configuration-error.ts";
import {
  CredentialNotFoundError,
  LinkCredentialNotFoundError,
  NoDefaultCredentialError,
  resolveEnvValues,
} from "../mcp-registry/credential-resolver.ts";

/**
 * A credential lookup that failed because the user simply hasn't connected the
 * provider yet — expected, not an app bug. Treated as a soft miss (the var
 * falls through to the missing-required handling). Anything else (expired
 * credential, refresh failure, non-string secret) is a hard failure surfaced
 * immediately.
 */
function isUnconnectedProviderError(err: unknown): boolean {
  return (
    err instanceof CredentialNotFoundError ||
    err instanceof NoDefaultCredentialError ||
    err instanceof LinkCredentialNotFoundError
  );
}

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

        // Resolve from Link through the shared resolver if value is missing
        // and a linkRef is declared. A provider-only ref resolves the
        // provider's default credential.
        if (!value && reqVar.linkRef) {
          try {
            const resolved = await resolveEnvValues(
              {
                [reqVar.name]: {
                  from: "link",
                  provider: reqVar.linkRef.provider,
                  key: reqVar.linkRef.key,
                },
              },
              logger,
            );
            value = resolved[reqVar.name];
            logger.debug("Resolved credential from Link", {
              operation: "environment_validation",
              workspaceId,
              agentId,
              variable: reqVar.name,
              provider: reqVar.linkRef.provider,
            });
          } catch (err) {
            // An unconnected provider is expected — continue and mark as a
            // missing required variable below.
            if (isUnconnectedProviderError(err)) {
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
              // Use warn (not error) since this is an expected user scenario, not an app bug.
              logger.warn("Credential resolution failed", {
                operation: "environment_validation",
                workspaceId,
                agentId,
                variable: reqVar.name,
                provider: reqVar.linkRef.provider,
                error: err,
              });
              throw UserConfigurationError.credentialRefreshFailed(
                agentId,
                reqVar.linkRef.provider,
                err,
              );
            }
          }
        }

        // If primary variable is missing, check if LITELLM_API_KEY can substitute.
        // Skip substitution if linkRef is present - user must connect via Link.
        // This prevents LITELLM keys from being passed to agents that need real provider keys
        // (e.g., Claude Code uses @anthropic-ai/claude-agent-sdk which requires a real sk-ant-* key).
        if (
          !value &&
          litellmKey &&
          LITELLM_SUBSTITUTABLE_KEYS.has(reqVar.name) &&
          !reqVar.linkRef
        ) {
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

    // Add optional environment variables. process.env wins; a linkRef resolves
    // the fallback through the shared resolver; the declared default is the
    // last resort. A failed optional lookup is never fatal.
    if (environmentConfig.optional) {
      for (const optVar of environmentConfig.optional) {
        let value = process.env[optVar.name];

        if (!value && optVar.linkRef) {
          try {
            const resolved = await resolveEnvValues(
              {
                [optVar.name]: {
                  from: "link",
                  provider: optVar.linkRef.provider,
                  key: optVar.linkRef.key,
                },
              },
              logger,
            );
            value = resolved[optVar.name];
          } catch (err) {
            logger.debug("Optional credential not resolved from Link", {
              operation: "environment_validation",
              workspaceId,
              agentId,
              variable: optVar.name,
              provider: optVar.linkRef.provider,
              error: err,
            });
          }
        }

        env[optVar.name] = value ?? optVar.default ?? "";
      }
    }

    // If there are missing credentials or variables, throw UserConfigurationError
    // This error type is handled specially - sessions won't be marked as "failed"
    // in metrics, preventing false alerts for user configuration issues.
    if (missingProviders.size > 0 || missingRequired.length > 0) {
      // Use warn (not error) since this is an expected user scenario - they haven't
      // connected their OAuth account or configured required environment variables yet.
      logger.warn("Environment variable validation failed", {
        missingVariables: missingRequired,
        missingProviders: [...missingProviders],
      });

      throw UserConfigurationError.missingConfiguration(
        agentId,
        workspaceId,
        [...missingProviders],
        missingRequired,
      );
    }

    logger.info("Validated environment variables", { providedVariables: Object.keys(env).length });
    return Promise.resolve(env);
  };
}
