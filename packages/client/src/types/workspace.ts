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

export interface WorkspaceAddRequest {
  path: string;
  name?: string;
  description?: string;
}

export interface WorkspaceBatchAddRequest {
  paths: string[];
}

export interface WorkspaceBatchAddResponse {
  added: WorkspaceInfo[];
  failed: Array<{
    path: string;
    error: string;
  }>;
}

export interface WorkspaceTemplateInfo {
  id: string;
  name: string;
  description: string;
  tags?: string[];
}

export interface CreateWorkspaceFromTemplateRequest {
  templateId: string;
  name: string;
  path: string;
}

export interface CreateWorkspaceFromTemplateResponse {
  id: string;
  name: string;
  path: string;
  templateId: string;
  message: string;
}
