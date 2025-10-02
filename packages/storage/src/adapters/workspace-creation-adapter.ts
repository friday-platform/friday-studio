/**
 * Workspace creation adapter interface for Atlas
 * Abstracts workspace directory creation and file writing from filesystem
 */

import { join } from "@std/path";

/**
 * Interface for workspace creation adapters
 * Handles directory creation with collision detection and workspace file writing
 */
export interface WorkspaceCreationAdapter {
  /**
   * Create a workspace directory with collision detection
   * @param basePath - Base directory (CWD or explicit path)
   * @param name - Workspace name
   * @returns Final path where workspace was created
   */
  createWorkspaceDirectory(basePath: string, name: string): Promise<string>;

  /**
   * Write workspace configuration files
   * @param workspacePath - Directory path
   * @param config - Workspace YAML configuration
   */
  writeWorkspaceFiles(
    workspacePath: string,
    config: string,
    options?: { ephemeral?: boolean },
  ): Promise<void>;
}

/**
 * Filesystem-based workspace creation adapter
 * Creates workspace directories and files using Deno filesystem APIs
 */
export class FilesystemWorkspaceCreationAdapter implements WorkspaceCreationAdapter {
  /**
   * Create a workspace directory with collision detection
   * Appends incremental counter (name-2, name-3, etc.) if directory exists
   */
  async createWorkspaceDirectory(basePath: string, name: string): Promise<string> {
    // First ensure the base path exists
    await Deno.mkdir(basePath, { recursive: true });

    let targetPath = join(basePath, name);
    let counter = 1;

    // Keep trying until we successfully create a directory
    while (true) {
      try {
        // Try to create the directory (without recursive flag for atomicity)
        await Deno.mkdir(targetPath, { recursive: false });
        // Success! Return this path
        return targetPath;
      } catch (error) {
        // Check if it's because directory already exists
        if (error instanceof Deno.errors.AlreadyExists) {
          // Try next number
          counter++;
          targetPath = join(basePath, `${name}-${counter}`);
        } else {
          // Some other error (permissions, etc.) - re-throw it
          throw error;
        }
      }
    }
  }

  /**
   * Write workspace configuration files
   * Creates workspace.yml and .env template
   */
  async writeWorkspaceFiles(
    workspacePath: string,
    config: string,
    options?: { ephemeral?: boolean },
  ): Promise<void> {
    // Write workspace.yml or eph_workspace.yml
    const configFileName = options?.ephemeral ? "eph_workspace.yml" : "workspace.yml";
    const configPath = join(workspacePath, configFileName);
    await Deno.writeTextFile(configPath, config);

    // Create .env file with placeholder
    const envPath = join(workspacePath, ".env");
    await Deno.writeTextFile(
      envPath,
      "# Add your environment variables here\nANTHROPIC_API_KEY=\n",
    );
  }
}
