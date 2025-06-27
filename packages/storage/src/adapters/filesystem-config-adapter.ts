/**
 * Filesystem implementation of ConfigurationAdapter
 * Loads configuration from local filesystem using Deno APIs
 */

import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import type { ConfigurationAdapter } from "./config-adapter.ts";

/**
 * Filesystem-based configuration adapter
 * Reads configuration files from the local filesystem
 */
export class FilesystemConfigAdapter implements ConfigurationAdapter {
  /**
   * Load and parse a YAML file from the filesystem
   */
  async loadYamlFile(path: string): Promise<unknown> {
    const content = await Deno.readTextFile(path);
    return parseYaml(content);
  }

  /**
   * Check if a file exists on the filesystem
   */
  async fileExists(path: string): Promise<boolean> {
    try {
      await Deno.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the path to atlas.yml configuration
   * Checks in order:
   * 1. Current working directory (workspace-local)
   * 2. Git repository root
   * 3. XDG config directory (~/.config/atlas/atlas.yml)
   */
  async resolveAtlasConfigPath(workspaceDir: string): Promise<string> {
    // 1. Check current working directory (CWD)
    const cwdAtlasPath = join(workspaceDir, "atlas.yml");
    if (await this.fileExists(cwdAtlasPath)) {
      return cwdAtlasPath;
    }

    // 2. Check git root
    try {
      const gitRoot = await this.getGitRoot();
      const gitAtlasPath = join(gitRoot, "atlas.yml");
      if (await this.fileExists(gitAtlasPath)) {
        return gitAtlasPath;
      }
    } catch {
      // Git not available or not in a git repository, continue to XDG
    }

    // 3. Check XDG config directory
    const xdgConfigDir = Deno.env.get("XDG_CONFIG_HOME") ||
      join(Deno.env.get("HOME") || "", ".config");
    const xdgConfigPath = join(xdgConfigDir, "atlas", "atlas.yml");
    if (await this.fileExists(xdgConfigPath)) {
      return xdgConfigPath;
    }

    // Return CWD path as default for creation
    return cwdAtlasPath;
  }

  /**
   * Resolve the path to workspace.yml configuration
   * Always in the workspace directory
   */
  resolveWorkspaceConfigPath(workspaceDir: string): Promise<string> {
    return Promise.resolve(join(workspaceDir, "workspace.yml"));
  }

  /**
   * Load all job specification files from a directory
   * Reads all .yml and .yaml files in the specified directory
   */
  async loadJobFiles(jobsDir: string): Promise<Map<string, unknown>> {
    const jobs = new Map<string, unknown>();

    try {
      for await (const entry of Deno.readDir(jobsDir)) {
        if (entry.isFile && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))) {
          const content = await this.loadYamlFile(join(jobsDir, entry.name));
          const jobName = entry.name.replace(/\.(yml|yaml)$/, "");
          jobs.set(jobName, content);
        }
      }
    } catch {
      // Jobs directory doesn't exist or can't be read
      // Return empty map - this is not an error condition
    }

    return jobs;
  }

  /**
   * Load supervisor default configuration
   * Returns the compiled defaults from the config package
   */
  async loadSupervisorDefaults(): Promise<unknown> {
    // Import the compiled supervisor defaults from the config package
    const { supervisorDefaults } = await import("@atlas/config");
    return supervisorDefaults;
  }

  /**
   * Get the git repository root directory
   * @private
   */
  private async getGitRoot(): Promise<string> {
    const gitCommand = new Deno.Command("git", {
      args: ["rev-parse", "--show-toplevel"],
      stdout: "piped",
      stderr: "piped",
    });

    const { success, stdout } = await gitCommand.output();

    if (!success) {
      throw new Error("Not in a git repository");
    }

    return new TextDecoder().decode(stdout).trim();
  }
}
