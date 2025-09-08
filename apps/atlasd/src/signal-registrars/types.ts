import type { WorkspaceManager } from "@atlas/workspace";

export interface WorkspaceSignalRegistrar {
  initialize(): Promise<void>;
  discoverAndRegisterExisting(workspaceManager: WorkspaceManager): Promise<void>;
  registerWorkspace(workspaceId: string, workspacePath: string): Promise<void>;
  unregisterWorkspace(workspaceId: string): void | Promise<void>;
  onWorkspaceConfigChanged(workspaceId: string, workspacePath: string): Promise<void>;
  shutdown(): Promise<void>;
}
