/**
 * Daemon API client for CLI commands
 * All CLI commands should use this to communicate with the daemon
 */

import { parseResult, client as v2Client } from "@atlas/client/v2";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";

interface WorkspaceInfo {
  id: string;
  name: string;
  description?: string;
  status: string;
  path: string;
  createdAt: string;
  lastSeen: string;
}

class DaemonClient {
  /**
   * Get detailed workspace information
   */
  async getWorkspace(
    workspaceId: string,
  ): Promise<
    WorkspaceInfo & {
      runtime?: { status: string; startedAt: string; sessions: number; workers: number };
    }
  > {
    const response = await parseResult(
      v2Client.workspace[":workspaceId"].$get({ param: { workspaceId } }),
    );
    if (!response.ok) {
      throw new Error(`Failed to get workspace: ${stringifyError(response.error)}`);
    }
    return response.data;
  }

  /**
   * Delete a workspace
   */
  async deleteWorkspace(workspaceId: string, force: boolean = false): Promise<{ message: string }> {
    const response = await parseResult(
      v2Client.workspace[":workspaceId"].$delete({
        param: { workspaceId },
        query: force ? { force: "true" } : {},
      }),
    );
    if (!response.ok) {
      throw new Error(`Failed to delete workspace: ${stringifyError(response.error)}`);
    }
    return response.data;
  }

  /**
   * List all sessions across workspaces
   */
  async listSessions(): Promise<
    Array<{
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
    }>
  > {
    const response = await parseResult(v2Client.sessions.index.$get({ query: {} }));
    if (!response.ok) {
      throw new Error(`Failed to list sessions: ${stringifyError(response.error)}`);
    }
    return response.data.sessions;
  }

  /**
   * Get specific session details
   */
  async getSession(
    sessionId: string,
  ): Promise<{
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
      output: unknown;
      error?: string;
    }>;
    results?: Record<string, unknown>;
    error?: string;
  }> {
    const response = await parseResult(v2Client.sessions[":id"].$get({ param: { id: sessionId } }));
    if (!response.ok) {
      throw new Error(`Failed to get session: ${stringifyError(response.error)}`);
    }
    return response.data;
  }

  /**
   * Cancel a session
   */
  async cancelSession(sessionId: string): Promise<{ message: string; workspaceId: string }> {
    const response = await parseResult(
      v2Client.sessions[":id"].$delete({ param: { id: sessionId } }),
    );
    if (!response.ok) {
      throw new Error(`Failed to cancel session: ${stringifyError(response.error)}`);
    }
    return response.data;
  }

  /**
   * List agents in a workspace
   */
  async listAgents(
    workspaceId: string,
  ): Promise<Array<{ id: string; type: string; description?: string }>> {
    const response = await parseResult(
      v2Client.workspace[":workspaceId"].agents.$get({ param: { workspaceId } }),
    );
    if (!response.ok) {
      throw new Error(`Failed to list agents: ${stringifyError(response.error)}`);
    }
    return response.data;
  }

  /**
   * List signals in a workspace
   */
  async listSignals(workspaceId: string): Promise<Array<{ name: string; description?: string }>> {
    const response = await parseResult(
      v2Client.workspace[":workspaceId"].signals.$get({ param: { workspaceId } }),
    );
    if (!response.ok) {
      throw new Error(`Failed to list signals: ${stringifyError(response.error)}`);
    }
    return response.data.signals;
  }

  /**
   * List jobs in a workspace
   */
  async listJobs(workspaceId: string): Promise<Array<{ name: string; description?: string }>> {
    const response = await parseResult(
      v2Client.workspace[":workspaceId"].jobs.$get({ param: { workspaceId } }),
    );
    if (!response.ok) {
      throw new Error(`Failed to list jobs: ${stringifyError(response.error)}`);
    }
    return response.data;
  }

  /**
   * List sessions in a specific workspace
   */
  async listWorkspaceSessions(
    workspaceId: string,
  ): Promise<Array<{ id: string; status: string; startedAt: string }>> {
    const response = await parseResult(
      v2Client.workspace[":workspaceId"].sessions.$get({ param: { workspaceId } }),
    );
    if (!response.ok) {
      throw new Error(`Failed to list workspace sessions: ${stringifyError(response.error)}`);
    }
    return response.data;
  }
}

// Default client instance
let defaultClient: DaemonClient | null = null;

export function getDaemonClient(): DaemonClient {
  if (!defaultClient) {
    defaultClient = new DaemonClient();
  }
  return defaultClient;
}

// Utility function to provide helpful error messages when daemon is not running
export function createDaemonNotRunningError(): Error {
  return new Error(
    `Atlas daemon is not running. Start it with 'atlas daemon start' or ensure it's accessible at ${getAtlasDaemonUrl()}`,
  );
}
