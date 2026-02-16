/**
 * Session-related type definitions
 *
 * These mirror the API response shapes from the daemon's /api/sessions routes.
 * List endpoint returns `{ sessions: SessionInfo[] }`.
 * Detail endpoint returns a `SessionDetailedInfo` (SessionView).
 */

export interface SessionInfo {
  sessionId: string;
  workspaceId: string;
  jobName: string;
  task: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  stepCount: number;
  agentNames: string[];
  error?: string;
  aiSummary?: {
    summary: string;
    keyDetails: Array<{ label: string; value: string; url?: string }>;
  };
}

export interface SessionDetailedInfo {
  sessionId: string;
  workspaceId: string;
  jobName: string;
  task: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  agentBlocks: Array<{
    agentName: string;
    actionType: string;
    task: string;
    status: string;
    durationMs?: number;
    toolCalls: Array<{ toolName: string; args?: unknown; result?: unknown; durationMs?: number }>;
    reasoning?: string;
    output: unknown;
    error?: string;
  }>;
  results?: Record<string, unknown>;
  error?: string;
  aiSummary?: {
    summary: string;
    keyDetails: Array<{ label: string; value: string; url?: string }>;
  };
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
