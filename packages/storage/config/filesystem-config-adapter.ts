/**
 * Filesystem-based implementation of the configuration adapter
 */

import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod/v4";
import type {
  AtlasConfig,
  JobSpecification,
  SupervisorDefaults,
  WorkspaceConfig,
} from "@atlas/types";
import {
  AtlasConfigSchema,
  ConfigValidationError,
  SupervisorDefaultsSchema,
  WorkspaceConfigSchema,
} from "@atlas/types";
import { IConfigurationAdapter } from "./config-adapter.ts";

/**
 * Configuration adapter that loads configuration from the filesystem
 * Supports loading from workspace directory, XDG config directory, and git root
 */
export class FileSystemConfigurationAdapter implements IConfigurationAdapter {
  private workspaceDir: string;
  private atlasConfigPath: string | null = null;
  private workspaceConfigPath: string;

  constructor(workspaceDir: string = ".") {
    this.workspaceDir = workspaceDir;
    this.workspaceConfigPath = join(this.workspaceDir, "workspace.yml");
  }

  /**
   * Find the atlas.yml configuration file
   * Search order:
   * 1. Current workspace directory
   * 2. XDG config directory (~/.config/atlas/atlas.yml)
   * 3. Git root directory (fallback)
   */
  private async findAtlasConfig(): Promise<string> {
    // 1. Check current workspace directory
    const localPath = join(this.workspaceDir, "atlas.yml");
    try {
      await Deno.stat(localPath);
      console.log(`Using workspace-local atlas.yml: ${localPath}`);
      return localPath;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }

    // 2. Check XDG config directory
    const xdgConfigDir = Deno.env.get("XDG_CONFIG_HOME") ||
      join(Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || ".", ".config");
    const xdgConfigPath = join(xdgConfigDir, "atlas", "atlas.yml");
    try {
      await Deno.stat(xdgConfigPath);
      console.log(`Using XDG config atlas.yml: ${xdgConfigPath}`);
      return xdgConfigPath;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }

    // 3. Fall back to git root atlas.yml (existing behavior)
    try {
      const gitRoot = new Deno.Command("git", {
        args: ["rev-parse", "--show-toplevel"],
        stdout: "piped",
      }).outputSync();
      const rootDir = new TextDecoder().decode(gitRoot.stdout).trim();
      const gitRootPath = join(rootDir, "atlas.yml");
      console.log(`Using git root atlas.yml: ${gitRootPath}`);
      return gitRootPath;
    } catch {
      // If we can't find git root, use workspace directory as fallback
      console.log(
        `Git root not found, will use/create workspace atlas.yml: ${localPath}`,
      );
      return localPath;
    }
  }

  async loadAtlasConfig(): Promise<AtlasConfig> {
    if (!this.atlasConfigPath) {
      this.atlasConfigPath = await this.findAtlasConfig();
    }

    try {
      const content = await Deno.readTextFile(this.atlasConfigPath);
      const rawConfig = parseYaml(content);

      // Validate with Zod
      const config = AtlasConfigSchema.parse(rawConfig);
      return config;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Return default atlas config if not found
        console.warn(
          "[FileSystemConfigurationAdapter] atlas.yml not found, using default configuration",
        );
        return this.createDefaultAtlasConfig();
      }
      if (error instanceof z.ZodError) {
        throw new ConfigValidationError(
          this.formatZodError(error, "atlas.yml"),
          "atlas.yml",
        );
      }
      throw new ConfigValidationError(
        `Failed to load atlas.yml: ${error instanceof Error ? error.message : String(error)}`,
        "atlas.yml",
      );
    }
  }

  async loadWorkspaceConfig(): Promise<WorkspaceConfig> {
    try {
      const content = await Deno.readTextFile(this.workspaceConfigPath);
      const rawConfig = parseYaml(content);

      // Validate with Zod
      const config = WorkspaceConfigSchema.parse(rawConfig);
      return config;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new ConfigValidationError(
          "workspace.yml not found - this file is required",
          "workspace.yml",
        );
      }
      if (error instanceof z.ZodError) {
        throw new ConfigValidationError(
          this.formatZodError(error, "workspace.yml"),
          "workspace.yml",
        );
      }
      throw new ConfigValidationError(
        `Failed to load workspace.yml: ${error instanceof Error ? error.message : String(error)}`,
        "workspace.yml",
      );
    }
  }

  async loadJobSpecs(): Promise<Record<string, JobSpecification>> {
    const jobs: Record<string, JobSpecification> = {};

    try {
      const jobsPath = join(this.workspaceDir, "jobs");

      // Check if jobs directory exists
      const stat = await Deno.stat(jobsPath);
      if (!stat.isDirectory) {
        return jobs;
      }

      // Read all .yml and .yaml files in jobs directory
      for await (const dirEntry of Deno.readDir(jobsPath)) {
        if (
          dirEntry.isFile &&
          (dirEntry.name.endsWith(".yml") || dirEntry.name.endsWith(".yaml"))
        ) {
          try {
            const jobFilePath = join(jobsPath, dirEntry.name);
            const jobContent = await Deno.readTextFile(jobFilePath);
            const jobSpec = parseYaml(jobContent) as JobSpecification;

            // Use filename (without extension) as job name if not specified
            const jobName = jobSpec.name || dirEntry.name.replace(/\.(yml|yaml)$/, "");

            // Normalize agents if needed
            if (jobSpec.execution?.agents) {
              jobSpec.execution.agents = jobSpec.execution.agents.map((agent) => {
                if (typeof agent === "string") {
                  return { id: agent };
                }
                return agent;
              });
            }

            jobs[jobName] = {
              ...jobSpec,
              name: jobName,
            };

            console.log(`Loaded job spec: ${jobName} from ${dirEntry.name}`);
          } catch (error) {
            console.error(`Failed to load job file ${dirEntry.name}: ${error}`);
          }
        }
      }
    } catch (error) {
      // Jobs directory doesn't exist or can't be read - that's fine
      console.log(`Jobs directory not found or accessible: ${error}`);
    }

    return jobs;
  }

  async loadSupervisorDefaults(): Promise<SupervisorDefaults> {
    try {
      // Try multiple paths for supervisor defaults
      const paths = [
        join(this.workspaceDir, "src", "config", "supervisor-defaults.yml"),
        join(this.workspaceDir, "config", "supervisor-defaults.yml"),
        join(this.workspaceDir, "supervisor-defaults.yml"),
      ];

      for (const path of paths) {
        try {
          const content = await Deno.readTextFile(path);
          const supervisorDefaults = parseYaml(content);

          // Validate against schema
          const validatedDefaults = SupervisorDefaultsSchema.parse(supervisorDefaults);

          console.log(`Loaded supervisor defaults from: ${path}`);
          return validatedDefaults;
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) {
            throw e;
          }
          // Continue to next path
        }
      }

      // If not found in any location, return minimal defaults
      console.warn(
        "Failed to load supervisor defaults from any location, using minimal fallback",
      );
      return this.createMinimalSupervisorDefaults();
    } catch (error) {
      console.warn("Failed to load supervisor defaults, using minimal fallback", {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.createMinimalSupervisorDefaults();
    }
  }

  private formatZodError(error: z.ZodError, filename: string): string {
    const issues = error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      let message = `  • ${path}: ${issue.message}`;

      // Add received value for certain issue types
      if ("received" in issue && issue.received !== undefined) {
        message += ` (received: ${issue.received})`;
      }

      return message;
    });

    return `Configuration validation failed in ${filename}:\n${
      issues.join("\n")
    }\n\nPlease check your configuration file and ensure all required fields are present and valid.`;
  }

  private createDefaultAtlasConfig(): AtlasConfig {
    const defaultConfig: AtlasConfig = {
      version: "1.0",
      workspace: {
        id: "atlas-platform",
        name: "Atlas Platform",
        description: "Default Atlas platform workspace with global management capabilities",
      },
      agents: {},
      supervisors: {
        workspace: {
          model: "claude-4-sonnet-20250514",
          prompts: {
            system:
              "You are a WorkspaceSupervisor responsible for analyzing signals and creating session contexts.",
          },
        },
        session: {
          model: "claude-4-sonnet-20250514",
          prompts: {
            system:
              "You are a SessionSupervisor responsible for coordinating agent execution within a session.",
          },
        },
        agent: {
          model: "claude-4-sonnet-20250514",
          prompts: {
            system: "You are an AgentSupervisor responsible for safe agent loading and execution.",
          },
        },
      },
    };

    // Validate the default config against the schema
    return AtlasConfigSchema.parse(defaultConfig);
  }

  private createMinimalSupervisorDefaults(): SupervisorDefaults {
    return {
      supervisors: {
        workspace: {
          model: "claude-3-5-sonnet-20241022",
          prompts: {
            system: "You are a WorkspaceSupervisor.",
          },
        },
        session: {
          model: "claude-3-5-sonnet-20241022",
          prompts: {
            system: "You are a SessionSupervisor.",
          },
        },
        agent: {
          model: "claude-3-5-sonnet-20241022",
          prompts: {
            system: "You are an AgentSupervisor.",
          },
        },
      },
    };
  }
}
