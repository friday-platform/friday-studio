/**
 * Environment Context Factory
 *
 * Creates functions for validating environment variables needed by agents.
 * Uses Deno.env for workspace-scoped variables and provides clear
 * error messages for missing requirements.
 */

import type { AgentEnvironmentConfig } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";

export interface EnvironmentValidationError extends Error {
  name: "EnvironmentValidationError";
  missingVariables: string[];
  workspaceId: string;
  agentId: string;
}

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
      return env;
    }

    const missingRequired: string[] = [];

    // Validate required environment variables
    if (environmentConfig.required) {
      for (const reqVar of environmentConfig.required) {
        const value = Deno.env.get(reqVar.name);

        if (value === undefined || value === "") {
          missingRequired.push(reqVar.name);
          continue;
        }

        // Validate against regex pattern if provided
        if (reqVar.validation) {
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
        const value = Deno.env.get(optVar.name);
        env[optVar.name] = value ?? optVar.default ?? "";
      }
    }

    // If there are missing required variables, throw detailed error
    if (missingRequired.length > 0) {
      const error = new Error(
        `Cannot execute ${agentId} in workspace '${workspaceId}': Required environment variables not found: ${missingRequired.join(
          ", ",
        )}. Please add these variables to your workspace .env file.`,
      ) as EnvironmentValidationError;

      error.name = "EnvironmentValidationError";
      error.missingVariables = missingRequired;
      error.workspaceId = workspaceId;
      error.agentId = agentId;

      logger.error("Environment validation failed", {
        operation: "environment_validation",
        workspaceId,
        agentId,
        missingVariables: missingRequired,
        requiredCount: environmentConfig.required?.length || 0,
        optionalCount: environmentConfig.optional?.length || 0,
      });

      throw error;
    }

    logger.info("Environment validation successful", {
      operation: "environment_validation",
      workspaceId,
      agentId,
      requiredVariables: environmentConfig.required?.length || 0,
      optionalVariables: environmentConfig.optional?.length || 0,
      providedVariables: Object.keys(env).length,
    });

    return env;
  };
}

/**
 * Generate help text for missing environment variables
 */
export function getEnvironmentHelp(environmentConfig: AgentEnvironmentConfig): string {
  if (!environmentConfig.required || environmentConfig.required.length === 0) {
    return "No environment variables required for this agent.";
  }

  const help = ["Required environment variables:"];

  for (const reqVar of environmentConfig.required) {
    help.push(`  ${reqVar.name}: ${reqVar.description}`);
    if (reqVar.validation) {
      help.push(`    Pattern: ${reqVar.validation}`);
    }
  }

  if (environmentConfig.optional && environmentConfig.optional.length > 0) {
    help.push("", "Optional environment variables:");
    for (const optVar of environmentConfig.optional) {
      const desc = optVar.description || "No description provided";
      const defaultValue = optVar.default ? ` (default: ${optVar.default})` : "";
      help.push(`  ${optVar.name}: ${desc}${defaultValue}`);
    }
  }

  help.push("", "Add these variables to your workspace .env file and retry.");

  return help.join("\n");
}
