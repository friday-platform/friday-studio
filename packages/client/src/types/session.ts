/**
 * Session-related type definitions
 */

export interface SessionInfo {
  id: string;
  workspaceId: string;
  status: string;
  summary: string;
  signal: string;
  startTime: string;
  endTime?: string;
  progress: number;
}

export interface SessionDetailedInfo extends SessionInfo {
  artifacts: Array<{ type: string; data: unknown }>;
  results?: unknown;
}

export interface WorkspaceSessionInfo {
  id: string;
  status: string;
  startedAt: string;
}

export interface CancelSessionResponse {
  message: string;
  workspaceId: string;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  component?: string;
  metadata?: Record<string, unknown>;
}
