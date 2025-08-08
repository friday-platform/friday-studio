/**
 * YAML Agent Parser
 *
 * Parses .agent.yml files into validated agent definitions with environment
 * variable interpolation. Handles file I/O, YAML parsing, and schema validation.
 */

import { parse as parseYAML } from "@std/yaml";
import {
  mergeEnvironmentConfig,
  validateEnvironment,
  validateYAMLAgent,
  type YAMLAgentDefinition,
} from "./schema.ts";
import { createLogger } from "@atlas/logger";

/** Options for YAML agent parsing. */
export interface ParseOptions {
  /** Environment variables for interpolation */
  env?: Record<string, string>;

  /** Whether to validate environment requirements */
  validateEnv?: boolean;

  /** Custom file reader (for testing) */
  fileReader?: (path: string) => Promise<string>;
}

/** Parse .agent.yml file into validated definition. */
export async function parseYAMLAgentFile(
  filePath: string,
  options: ParseOptions = {},
): Promise<YAMLAgentDefinition> {
  const {
    env = {},
    validateEnv = true,
    fileReader = Deno.readTextFile,
  } = options;

  try {
    // Read the YAML file
    const content = await fileReader(filePath);

    // Parse YAML with environment variable interpolation
    const interpolated = interpolateEnvironmentVariables(content, env);
    const parsed = parseYAML(interpolated);

    // Validate against schema
    const validated = validateYAMLAgent(parsed);

    // Validate environment requirements if requested
    if (validateEnv && validated.environment) {
      const mergedEnv = mergeEnvironmentConfig(validated.environment, env);
      validateEnvironment(validated.environment, mergedEnv);
    }

    return validated;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Agent file not found: ${filePath}`);
    }

    if (error instanceof Error) {
      throw new Error(`Failed to parse agent file ${filePath}: ${error.message}`);
    }

    throw error;
  }
}

/** Parse YAML agent content string into validated definition. */
export function parseYAMLAgentContent(
  content: string,
  options: Omit<ParseOptions, "fileReader"> = {},
): YAMLAgentDefinition {
  const { env = {}, validateEnv = true } = options;

  try {
    // Parse YAML with environment variable interpolation
    const interpolated = interpolateEnvironmentVariables(content, env);
    const parsed = parseYAML(interpolated);

    // Validate against schema
    const validated = validateYAMLAgent(parsed);

    // Validate environment requirements if requested
    if (validateEnv && validated.environment) {
      const mergedEnv = mergeEnvironmentConfig(validated.environment, env);
      validateEnvironment(validated.environment, mergedEnv);
    }

    return validated;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to parse YAML agent: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Interpolate environment variables in YAML content.
 * Supports ${VAR_NAME} and ${VAR_NAME:-default} syntax.
 */
export function interpolateEnvironmentVariables(
  content: string,
  env: Record<string, string>,
): string {
  const pattern = /\$\{([A-Z_][A-Z0-9_]*)(:-([^}]*))?\}/g;

  return content.replace(pattern, (match, varName, _, defaultValue) => {
    const value = env[varName];

    if (value !== undefined) {
      return value;
    }

    if (defaultValue !== undefined) {
      return defaultValue;
    }

    return match;
  });
}

/** Load all .agent.yml files from directory. */
export async function loadYAMLAgentsFromDirectory(
  directory: string,
  options: ParseOptions = {},
): Promise<Array<{ path: string; agent: YAMLAgentDefinition }>> {
  const agents: Array<{ path: string; agent: YAMLAgentDefinition }> = [];
  const logger = createLogger({ component: "YAMLParser" });

  try {
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isFile && entry.name.endsWith(".agent.yml")) {
        const filePath = `${directory}/${entry.name}`;

        try {
          const agent = await parseYAMLAgentFile(filePath, options);
          agents.push({ path: filePath, agent });
        } catch (error) {
          logger.error("Failed to load agent from file", { filePath, error });
        }
      }
    }

    return agents;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Agent directory not found: ${directory}`);
    }
    throw error;
  }
}

/** Extract MCP server names from YAML definition. */
export function extractMCPServerNames(definition: YAMLAgentDefinition): string[] {
  if (!definition.mcp_servers) {
    return [];
  }

  return Object.keys(definition.mcp_servers);
}

/** Extract tool allowlist for specific MCP server. */
export function extractToolAllowlist(
  definition: YAMLAgentDefinition,
  serverName: string,
): string[] | undefined;

/** Extract tool allowlists for all MCP servers. */
export function extractToolAllowlist(
  definition: YAMLAgentDefinition,
): Record<string, string[]>;

export function extractToolAllowlist(
  definition: YAMLAgentDefinition,
  serverName?: string,
): string[] | undefined | Record<string, string[]> {
  if (serverName) {
    const serverConfig = definition.mcp_servers?.[serverName];
    return serverConfig?.tools?.allow;
  }

  // Return allowlists for all servers
  const result: Record<string, string[]> = {};
  if (definition.mcp_servers) {
    for (const [name, config] of Object.entries(definition.mcp_servers)) {
      if (config.tools?.allow) {
        result[name] = config.tools.allow;
      }
    }
  }
  return result;
}

/** Extract tool denylist for specific MCP server. */
export function extractToolDenylist(
  definition: YAMLAgentDefinition,
  serverName: string,
): string[] | undefined;

/** Extract tool denylists for all MCP servers. */
export function extractToolDenylist(
  definition: YAMLAgentDefinition,
): Record<string, string[]>;

export function extractToolDenylist(
  definition: YAMLAgentDefinition,
  serverName?: string,
): string[] | undefined | Record<string, string[]> {
  if (serverName) {
    const serverConfig = definition.mcp_servers?.[serverName];
    return serverConfig?.tools?.deny;
  }

  const result: Record<string, string[]> = {};
  if (definition.mcp_servers) {
    for (const [name, config] of Object.entries(definition.mcp_servers)) {
      if (config.tools?.deny) {
        result[name] = config.tools.deny;
      }
    }
  }
  return result;
}

/**
 * Validate YAML agent file without throwing.
 * Returns validation result with errors.
 */
export async function validateYAMLAgentFile(
  filePath: string,
  options: ParseOptions = {},
): Promise<{ valid: boolean; errors?: string[] }> {
  try {
    await parseYAMLAgentFile(filePath, options);
    return { valid: true };
  } catch (error) {
    if (error instanceof Error) {
      return {
        valid: false,
        errors: error.message.split("\n").filter((line) => line.trim()),
      };
    }
    return { valid: false, errors: ["Unknown validation error"] };
  }
}
