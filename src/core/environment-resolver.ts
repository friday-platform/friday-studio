/**
 * Environment Variable Resolver for Atlas
 * Handles comprehensive credential management with multiple source types
 */

import { z } from "zod/v4";
import { parse as parseEnvFile } from "@std/dotenv";
import type { EnvironmentVariable } from "@atlas/types";

export class EnvironmentResolutionError extends Error {
  constructor(
    message: string,
    public variable: string,
    public source?: string,
  ) {
    super(message);
    this.name = "EnvironmentResolutionError";
  }
}

export interface EnvironmentResolutionResult {
  value: string;
  source: "value" | "from_env" | "from_env_file" | "from_file" | "default";
  resolved: boolean;
}

export class EnvironmentResolver {
  private envFileCache = new Map<string, Record<string, string>>();

  /**
   * Resolve an environment variable configuration to its final value
   */
  async resolve(
    variableName: string,
    config: EnvironmentVariable,
  ): Promise<EnvironmentResolutionResult> {
    // Handle string shorthand (direct value)
    if (typeof config === "string") {
      return {
        value: config,
        source: "value",
        resolved: true,
      };
    }

    // Evaluation order: from_env_file → from_env → from_file → default
    const sources = [
      { type: "from_env_file" as const, getValue: () => this.resolveFromEnvFile(config) },
      { type: "from_env" as const, getValue: () => this.resolveFromEnv(config) },
      { type: "from_file" as const, getValue: () => this.resolveFromFile(config) },
      { type: "value" as const, getValue: () => this.resolveValue(config) },
      { type: "default" as const, getValue: () => this.resolveDefault(config) },
    ];

    for (const source of sources) {
      try {
        const value = await source.getValue();
        if (value !== undefined) {
          return {
            value,
            source: source.type,
            resolved: true,
          };
        }
      } catch (error) {
        // Continue to next source on error
        console.warn(`Failed to resolve ${variableName} from ${source.type}: ${error.message}`);
      }
    }

    // If required and no value found, throw error
    if (config.required) {
      throw new EnvironmentResolutionError(
        `Required environment variable '${variableName}' could not be resolved from any source`,
        variableName,
      );
    }

    return {
      value: "",
      source: "default",
      resolved: false,
    };
  }

  /**
   * Resolve multiple environment variables in batch
   */
  async resolveAll(
    envConfig: Record<string, EnvironmentVariable>,
  ): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    const errors: EnvironmentResolutionError[] = [];

    for (const [key, config] of Object.entries(envConfig)) {
      try {
        const result = await this.resolve(key, config);
        if (result.resolved) {
          resolved[key] = result.value;
        }
      } catch (error) {
        if (error instanceof EnvironmentResolutionError) {
          errors.push(error);
        } else {
          errors.push(
            new EnvironmentResolutionError(
              `Unexpected error resolving ${key}: ${error.message}`,
              key,
            ),
          );
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Environment resolution failed for ${errors.length} variables:\n${
          errors.map((e) => `  ${e.variable}: ${e.message}`).join("\n")
        }`,
      );
    }

    return resolved;
  }

  private async resolveFromEnvFile(config: any): Promise<string | undefined> {
    if (!config.from_env_file) return undefined;

    const envFile = await this.loadEnvFile(config.from_env_file);
    const key = config.key || Object.keys(envFile)[0]; // Use first key if not specified

    if (!key) {
      throw new Error("No key specified for env file resolution");
    }

    return envFile[key];
  }

  private resolveFromEnv(config: any): string | undefined {
    if (!config.from_env) return undefined;
    return Deno.env.get(config.from_env);
  }

  private async resolveFromFile(config: any): Promise<string | undefined> {
    if (!config.from_file) return undefined;

    try {
      const content = await Deno.readTextFile(config.from_file);
      return content.trim(); // Remove trailing newlines
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return undefined; // File not found, continue to next source
      }
      throw error;
    }
  }

  private resolveValue(config: any): string | undefined {
    return config.value;
  }

  private resolveDefault(config: any): string | undefined {
    return config.default;
  }

  private async loadEnvFile(filePath: string): Promise<Record<string, string>> {
    if (this.envFileCache.has(filePath)) {
      return this.envFileCache.get(filePath)!;
    }

    try {
      const content = await Deno.readTextFile(filePath);
      const parsed = parseEnvFile(content);
      this.envFileCache.set(filePath, parsed);
      return parsed;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        const empty = {};
        this.envFileCache.set(filePath, empty);
        return empty;
      }
      throw new Error(`Failed to load env file ${filePath}: ${error.message}`);
    }
  }

  /**
   * Clear the env file cache (useful for testing)
   */
  clearCache(): void {
    this.envFileCache.clear();
  }

  /**
   * Validate environment variable configuration
   */
  static validate(config: EnvironmentVariable): boolean {
    if (typeof config === "string") return true;

    // At least one source must be specified
    const hasSources = [
      config.value,
      config.from_env,
      config.from_env_file,
      config.from_file,
      config.default,
    ].some((source) => source !== undefined);

    return hasSources;
  }

  /**
   * Get documentation for environment variable configuration
   */
  static getDocumentation(): string {
    return `
Environment Variable Configuration Options:

1. Direct Value:
   VARIABLE_NAME: "literal-value"

2. Environment Variable:
   VARIABLE_NAME:
     from_env: "ENV_VAR_NAME"
     required: true

3. Environment File (.env style):
   VARIABLE_NAME:
     from_env_file: ".env"
     key: "DATABASE_URL"
     required: true

4. File Contents (Docker secrets, credential files):
   VARIABLE_NAME:
     from_file: "/run/secrets/secret_key"
     required: true

5. Multiple Sources with Fallback:
   VARIABLE_NAME:
     from_env_file: ".env"           # Try .env file first
     key: "API_KEY"
     from_env: "API_KEY"             # Then environment
     from_file: "~/.config/api_key"  # Then file
     default: ""                     # Finally default
     required: false

Evaluation Order: from_env_file → from_env → from_file → value → default
`.trim();
  }
}
