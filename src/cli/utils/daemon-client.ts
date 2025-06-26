/**
 * Daemon API client for CLI commands
 * All CLI commands should use this to communicate with the daemon
 */

export interface DaemonClientOptions {
  daemonUrl?: string;
  timeout?: number;
}

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

export class DaemonClient {
  private daemonUrl: string;
  private timeout: number;

  constructor(options: DaemonClientOptions = {}) {
    this.daemonUrl = options.daemonUrl || "http://localhost:8080";
    this.timeout = options.timeout || 10000; // 10 seconds
  }

  /**
   * Check if daemon is running and accessible
   */
  async isHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.daemonUrl}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get daemon status
   */
  async getDaemonStatus(): Promise<{
    status: string;
    activeWorkspaces: number;
    uptime: number;
    workspaces: string[];
  }> {
    const response = await this.makeRequest("/api/daemon/status");
    return response;
  }

  /**
   * List all workspaces
   */
  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const response = await this.makeRequest("/api/workspaces");
    return response;
  }

  /**
   * Get detailed workspace information
   */
  async getWorkspace(workspaceId: string): Promise<
    WorkspaceInfo & {
      runtime?: {
        status: string;
        startedAt: string;
        sessions: number;
        workers: number;
      };
    }
  > {
    const response = await this.makeRequest(`/api/workspaces/${workspaceId}`);
    return response;
  }

  /**
   * Create a new workspace
   */
  async createWorkspace(request: WorkspaceCreateRequest): Promise<WorkspaceCreateResponse> {
    const response = await this.makeRequest("/api/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
    return response;
  }

  /**
   * Delete a workspace
   */
  async deleteWorkspace(workspaceId: string, force: boolean = false): Promise<{ message: string }> {
    const url = new URL(`${this.daemonUrl}/api/workspaces/${workspaceId}`);
    if (force) {
      url.searchParams.set("force", "true");
    }

    const response = await this.makeRequest(url.pathname + url.search, {
      method: "DELETE",
    });
    return response;
  }

  /**
   * Trigger a signal in a workspace
   */
  async triggerSignal(
    workspaceId: string,
    signalId: string,
    payload: Record<string, unknown> = {},
  ): Promise<{
    message: string;
    status: string;
    workspaceId: string;
    signalId: string;
  }> {
    const response = await this.makeRequest(`/api/workspaces/${workspaceId}/signals/${signalId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return response;
  }

  /**
   * List all sessions across workspaces
   */
  async listSessions(): Promise<
    Array<{
      id: string;
      workspaceId: string;
      status: string;
      summary: string;
      signal: string;
      startTime: string;
      endTime?: string;
      progress: number;
    }>
  > {
    const response = await this.makeRequest("/api/sessions");
    return response;
  }

  /**
   * Get specific session details
   */
  async getSession(sessionId: string): Promise<{
    id: string;
    workspaceId: string;
    status: string;
    progress: number;
    summary: string;
    signal: string;
    startTime: string;
    endTime?: string;
    artifacts: Array<{ type: string; data: any }>;
    results?: any;
  }> {
    const response = await this.makeRequest(`/api/sessions/${sessionId}`);
    return response;
  }

  /**
   * Cancel a session
   */
  async cancelSession(sessionId: string): Promise<{ message: string; workspaceId: string }> {
    const response = await this.makeRequest(`/api/sessions/${sessionId}`, {
      method: "DELETE",
    });
    return response;
  }

  /**
   * List agents in a workspace
   */
  async listAgents(workspaceId: string): Promise<
    Array<{
      id: string;
      type: string;
      purpose?: string;
    }>
  > {
    const response = await this.makeRequest(`/api/workspaces/${workspaceId}/agents`);
    return response;
  }

  /**
   * Describe a specific agent in a workspace
   */
  async describeAgent(workspaceId: string, agentId: string): Promise<any> {
    const response = await this.makeRequest(`/api/workspaces/${workspaceId}/agents/${agentId}`);
    return response;
  }

  /**
   * List signals in a workspace
   */
  async listSignals(workspaceId: string): Promise<
    Array<{
      name: string;
      description?: string;
    }>
  > {
    const response = await this.makeRequest(`/api/workspaces/${workspaceId}/signals`);
    return response;
  }

  /**
   * List jobs in a workspace
   */
  async listJobs(workspaceId: string): Promise<
    Array<{
      name: string;
      description?: string;
    }>
  > {
    const response = await this.makeRequest(`/api/workspaces/${workspaceId}/jobs`);
    return response;
  }

  /**
   * List sessions in a specific workspace
   */
  async listWorkspaceSessions(workspaceId: string): Promise<
    Array<{
      id: string;
      status: string;
      startedAt: string;
    }>
  > {
    const response = await this.makeRequest(`/api/workspaces/${workspaceId}/sessions`);
    return response;
  }

  /**
   * Shutdown the daemon
   */
  async shutdown(): Promise<{ message: string }> {
    const response = await this.makeRequest("/api/daemon/shutdown", {
      method: "POST",
    });
    return response;
  }

  /**
   * Make a request to the daemon API with error handling
   */
  private async makeRequest(path: string, options: RequestInit = {}): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.daemonUrl}${path}`, {
        signal: controller.signal,
        ...options,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorMessage: string;
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || `HTTP ${response.status}: ${response.statusText}`;
        } catch {
          errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        }
        throw new DaemonApiError(errorMessage, response.status);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof DaemonApiError) {
        throw error;
      }

      if (error.name === "AbortError") {
        throw new DaemonApiError(
          `Request to daemon timed out after ${this.timeout}ms. Is the daemon running?`,
          408,
        );
      }

      // Network errors
      throw new DaemonApiError(
        `Failed to connect to daemon at ${this.daemonUrl}. Is the daemon running? Error: ${error.message}`,
        503,
      );
    }
  }
}

export class DaemonApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "DaemonApiError";
  }
}

// Default client instance
let defaultClient: DaemonClient | null = null;

export function getDaemonClient(options?: DaemonClientOptions): DaemonClient {
  if (!defaultClient) {
    defaultClient = new DaemonClient(options);
  }
  return defaultClient;
}

// Utility function for CLI commands to detect if daemon is running
export async function checkDaemonRunning(): Promise<boolean> {
  const client = getDaemonClient();
  return await client.isHealthy();
}

// Utility function to provide helpful error messages when daemon is not running
export function createDaemonNotRunningError(): Error {
  return new Error(
    "Atlas daemon is not running. Start it with 'atlas daemon start' or ensure it's accessible at http://localhost:8080",
  );
}
