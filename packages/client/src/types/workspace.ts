/**
 * Workspace-related type definitions
 */

export interface WorkspaceInfo {
  id: string;
  name: string;
  description?: string;
  status: string;
  path: string;
  hasActiveRuntime: boolean;
  createdAt: string;
  lastSeen: string;
}

export interface WorkspaceCreateRequest {
  name: string;
  description?: string;
  template?: string;
  config?: Record<string, unknown>;
}

export interface WorkspaceCreateResponse {
  id: string;
  name: string;
}

export interface WorkspaceRuntime {
  status: string;
  startedAt: string;
  sessions: number;
  workers: number;
}

export interface WorkspaceDetailedInfo extends WorkspaceInfo {
  runtime?: WorkspaceRuntime;
}
