/**
 * Workspace-related type definitions
 */

import type { Color } from "@atlas/utils";

export interface WorkspaceInfo {
  id: string;
  name: string;
  description?: string;
  status: string;
  path: string;
  createdAt: string;
  lastSeen: string;
  color?: Color;
}

export interface WorkspaceCreateRequest {
  name: string;
  description?: string;
  template?: string;
  config: Record<string, unknown>;
}

export interface WorkspaceCreateResponse {
  id: string;
  name: string;
}

interface WorkspaceRuntime {
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
  failed: Array<{ path: string; error: string }>;
}
