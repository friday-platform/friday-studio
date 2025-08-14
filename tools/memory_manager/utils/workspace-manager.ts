/**
 * Workspace Manager Utility for Memory Manager
 *
 * Provides workspace listing functionality for the memory manager
 * to allow users to select from available workspaces.
 */

import { getWorkspaceManager, type WorkspaceEntry } from "@atlas/workspace";

export class MemoryManagerWorkspaceService {
  /**
   * List all available workspaces (excluding system workspaces by default)
   */
  async listWorkspaces(includeSystem = false): Promise<WorkspaceEntry[]> {
    try {
      const manager = await getWorkspaceManager();
      const workspaces = await manager.list({ includeSystem });

      // Return workspaces directly as they already match the WorkspaceEntry type
      return workspaces;
    } catch (error) {
      throw new Error(
        `Failed to list workspaces: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Find workspace by path
   */
  async findWorkspaceByPath(path: string): Promise<WorkspaceEntry | null> {
    try {
      const manager = await getWorkspaceManager();
      const workspace = await manager.find({ path });

      if (!workspace) return null;

      return workspace;
    } catch (error) {
      throw new Error(
        `Failed to find workspace: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check if a path is a valid workspace
   */
  async isValidWorkspace(path: string): Promise<boolean> {
    try {
      const workspace = await this.findWorkspaceByPath(path);
      return workspace !== null;
    } catch {
      return false;
    }
  }

  /**
   * Get workspace by ID
   */
  async getWorkspace(id: string): Promise<WorkspaceEntry | null> {
    try {
      const manager = await getWorkspaceManager();
      const workspace = await manager.find({ id });

      if (!workspace) return null;

      return workspace;
    } catch (error) {
      throw new Error(
        `Failed to get workspace: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
