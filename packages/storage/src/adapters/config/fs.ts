/**
 * Filesystem implementation of ConfigurationAdapter
 * Loads configuration from local filesystem
 */

import { readFile, stat } from "node:fs/promises";
import { parse as parseYaml } from "@std/yaml";
import type { ConfigurationAdapter } from "./mod.ts";

/**
 * Filesystem-based configuration adapter
 * Reads configuration files from the local filesystem
 */
export class FilesystemConfigAdapter implements ConfigurationAdapter {
  constructor(private workspacePath: string) {}

  /**
   * Read and parse a YAML file from the filesystem
   */
  async readYaml(path: string): Promise<unknown> {
    const content = await readFile(path, "utf-8");
    return parseYaml(content);
  }

  /**
   * Check if a file exists on the filesystem
   */
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the workspace path
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }
}
