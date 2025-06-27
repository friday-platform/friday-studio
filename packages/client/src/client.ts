/**
 * Atlas API client for CLI commands and other consumers
 * All CLI commands should use this to communicate with the Atlas daemon
 */

import { z } from "zod/v4";
import { AtlasApiError } from "./errors.ts";
import { DEFAULT_ATLAS_URL, DEFAULT_TIMEOUT } from "./constants.ts";
import {
  AgentInfoSchema,
  CancelSessionResponseSchema,
  DaemonStatusSchema,
  DeleteResponseSchema,
  JobInfoSchema,
  LibraryItemWithContentSchema,
  LibrarySearchResultSchema,
  LibraryStatsSchema,
  MessageResponseSchema,
  SessionDetailedInfoSchema,
  SessionInfoSchema,
  SessionLogsResponseSchema,
  SignalInfoSchema,
  SignalTriggerResponseSchema,
  TemplateConfigSchema,
  WorkspaceCreateResponseSchema,
  WorkspaceDetailedInfoSchema,
  WorkspaceInfoSchema,
  WorkspaceSessionInfoSchema,
} from "./schemas.ts";
import type {
  AgentInfo,
  AtlasClientOptions,
  CancelSessionResponse,
  DaemonStatus,
  DeleteLibraryItemResponse,
  JobInfo,
  LibraryItemWithContent,
  LibrarySearchQuery,
  LibrarySearchResult,
  LibraryStats,
  LogEntry,
  SessionDetailedInfo,
  SessionInfo,
  SignalDetailedInfo,
  SignalInfo,
  SignalResponse,
  SignalTriggerResponse,
  TemplateConfig,
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceDetailedInfo,
  WorkspaceInfo,
  WorkspaceSessionInfo,
} from "./types/index.ts";

export class AtlasClient {
  private url: string;
  private timeout: number;

  constructor(options: AtlasClientOptions = {}) {
    this.url = options.url || DEFAULT_ATLAS_URL;
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  /**
   * Check if Atlas daemon is running and accessible
   */
  async isHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.url}/health`, {
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
  async getDaemonStatus(): Promise<DaemonStatus> {
    const response = await this.makeRequest("/api/daemon/status");
    return DaemonStatusSchema.parse(response);
  }

  /**
   * List all workspaces
   */
  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const response = await this.makeRequest("/api/workspaces");
    return z.array(WorkspaceInfoSchema).parse(response);
  }

  /**
   * Get detailed workspace information
   */
  async getWorkspace(workspaceId: string): Promise<WorkspaceDetailedInfo> {
    const response = await this.makeRequest(`/api/workspaces/${workspaceId}`);
    return WorkspaceDetailedInfoSchema.parse(response);
  }

  /**
   * Get workspace path only without triggering full validation
   */
  async getWorkspacePath(workspaceId: string): Promise<string> {
    const workspaces = await this.listWorkspaces();
    const workspace = workspaces.find((w) => w.id === workspaceId);

    if (!workspace) {
      throw new AtlasApiError(`Workspace '${workspaceId}' not found`, 404);
    }

    return workspace.path;
  }

  /**
   * Create a new workspace
   */
  async createWorkspace(
    request: WorkspaceCreateRequest,
  ): Promise<WorkspaceCreateResponse> {
    const response = await this.makeRequest("/api/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
    return WorkspaceCreateResponseSchema.parse(response);
  }

  /**
   * Delete a workspace
   */
  async deleteWorkspace(
    workspaceId: string,
    force: boolean = false,
  ): Promise<{ message: string }> {
    const url = new URL(`${this.url}/api/workspaces/${workspaceId}`);
    if (force) {
      url.searchParams.set("force", "true");
    }

    const response = await this.makeRequest(url.pathname + url.search, {
      method: "DELETE",
    });
    return MessageResponseSchema.parse(response);
  }

  /**
   * Trigger a signal in a workspace
   */
  async triggerSignal(
    workspaceId: string,
    signalId: string,
    payload: Record<string, unknown> = {},
  ): Promise<SignalTriggerResponse> {
    const response = await this.makeRequest(
      `/api/workspaces/${workspaceId}/signals/${signalId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
    return SignalTriggerResponseSchema.parse(response);
  }

  /**
   * Trigger a signal directly on workspace server (different endpoint pattern)
   */
  async triggerWorkspaceSignal(
    port: number,
    signalName: string,
    payload: Record<string, unknown>,
  ): Promise<SignalResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(
        `http://localhost:${port}/signals/${signalName}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new AtlasApiError(
          `Failed to trigger signal: ${response.status} ${response.statusText}. ${errorText}`,
          response.status,
        );
      }

      const data = await response.json();
      return {
        success: true,
        message: data.message || `Signal '${signalName}' triggered successfully`,
        sessionId: data.sessionId,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof AtlasApiError) {
        throw error;
      }

      if (error.name === "AbortError") {
        throw new AtlasApiError(
          `Request to workspace server timed out after ${this.timeout}ms`,
          408,
        );
      }

      throw new AtlasApiError(
        `Failed to connect to workspace server on port ${port}. Error: ${error.message}`,
        503,
      );
    }
  }

  /**
   * List all sessions across workspaces
   */
  async listSessions(): Promise<SessionInfo[]> {
    const response = await this.makeRequest("/api/sessions");
    return z.array(SessionInfoSchema).parse(response);
  }

  /**
   * Get specific session details
   */
  async getSession(sessionId: string): Promise<SessionDetailedInfo> {
    const response = await this.makeRequest(`/api/sessions/${sessionId}`);
    return SessionDetailedInfoSchema.parse(response);
  }

  /**
   * Cancel a session
   */
  async cancelSession(sessionId: string): Promise<CancelSessionResponse> {
    const response = await this.makeRequest(`/api/sessions/${sessionId}`, {
      method: "DELETE",
    });
    return CancelSessionResponseSchema.parse(response);
  }

  /**
   * Get session logs
   */
  async getSessionLogs(
    sessionId: string,
    options?: {
      tail?: number;
      follow?: boolean;
      filter?: string;
    },
  ): Promise<LogEntry[]> {
    const params = new URLSearchParams();
    if (options?.tail) params.set("tail", options.tail.toString());
    if (options?.filter) params.set("filter", options.filter);

    const queryString = params.toString();
    const path = queryString
      ? `/sessions/${sessionId}/logs?${queryString}`
      : `/sessions/${sessionId}/logs`;

    const response = await this.makeRequest(path);
    const parsed = SessionLogsResponseSchema.parse(response);
    return parsed.logs;
  }

  /**
   * Stream session logs using Server-Sent Events
   */
  async *streamSessionLogs(
    sessionId: string,
    options?: {
      tail?: number;
      filter?: string;
    },
  ): AsyncIterableIterator<LogEntry> {
    const params = new URLSearchParams();
    if (options?.tail) params.set("tail", options.tail.toString());
    if (options?.filter) params.set("filter", options.filter);
    params.set("stream", "true");

    const queryString = params.toString();
    const path = `/sessions/${sessionId}/logs?${queryString}`;

    const response = await fetch(`${this.url}${path}`, {
      headers: {
        Accept: "text/event-stream",
      },
    });

    if (!response.ok) {
      throw new AtlasApiError(
        `Failed to stream logs: ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new AtlasApiError("No response body available for streaming", 500);
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              yield data as LogEntry;
            } catch {
              // Ignore invalid JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * List agents in a workspace
   */
  async listAgents(workspaceId: string): Promise<AgentInfo[]> {
    const response = await this.makeRequest(
      `/api/workspaces/${workspaceId}/agents`,
    );
    return z.array(AgentInfoSchema).parse(response);
  }

  /**
   * Describe a specific agent in a workspace
   */
  async describeAgent(workspaceId: string, agentId: string): Promise<unknown> {
    const response = await this.makeRequest(
      `/api/workspaces/${workspaceId}/agents/${agentId}`,
    );
    return response;
  }

  /**
   * List signals in a workspace
   */
  async listSignals(workspaceId: string): Promise<SignalInfo[]> {
    const response = await this.makeRequest(
      `/api/workspaces/${workspaceId}/signals`,
    );
    return z.array(SignalInfoSchema).parse(response);
  }

  /**
   * Describe a specific signal in a workspace
   * Note: This uses a hybrid approach since there's no dedicated signal describe endpoint
   */
  async describeSignal(
    workspaceId: string,
    signalName: string,
    workspacePath: string,
  ): Promise<SignalDetailedInfo> {
    // First verify the signal exists
    const signals = await this.listSignals(workspaceId);
    const signal = signals.find((s) => s.name === signalName);

    if (!signal) {
      throw new AtlasApiError(
        `Signal '${signalName}' not found in workspace`,
        404,
      );
    }

    // Load signal configuration directly using provided workspace path
    const signalConfig = await this.loadSignalConfig(workspacePath, signalName);

    // Return without schema validation for now to avoid Zod issues
    return signalConfig as SignalDetailedInfo;
  }

  /**
   * Load signal configuration from workspace config without triggering agent validation
   * Private method to support describeSignal
   */
  private async loadSignalConfig(
    workspacePath: string,
    signalName: string,
  ): Promise<Record<string, unknown>> {
    // Load raw YAML without full ConfigLoader validation to avoid agent/job validation
    try {
      // Read and parse workspace.yml directly to avoid validation issues
      const yaml = await import("@std/yaml");

      const workspaceYmlPath = `${workspacePath}/workspace.yml`;
      const yamlContent = await Deno.readTextFile(workspaceYmlPath);
      const rawConfig = yaml.parse(yamlContent) as any;

      // Extract signal configuration (signals can be at root or under workspace)
      const signalConfig = rawConfig?.workspace?.signals?.[signalName] ||
        rawConfig?.signals?.[signalName];

      if (!signalConfig) {
        throw new AtlasApiError(
          `Signal '${signalName}' configuration not found`,
          404,
        );
      }

      // Ensure required fields for SignalDetailedInfo schema
      const detailedConfig = {
        name: signalName,
        description: signalConfig.description,
        provider: signalConfig.provider || "unknown",
        method: signalConfig.method,
        path: signalConfig.path,
        endpoint: signalConfig.endpoint,
        headers: signalConfig.headers,
        config: signalConfig.config,
        schema: signalConfig.schema,
        webhook_secret: signalConfig.webhook_secret,
        timeout_ms: signalConfig.timeout_ms,
        retry_config: signalConfig.retry_config,
      };

      return detailedConfig;
    } catch (error) {
      if (error instanceof AtlasApiError) {
        throw error;
      }

      // Handle file not found errors specifically
      if (error instanceof Deno.errors.NotFound) {
        throw new AtlasApiError(
          `Workspace configuration file not found at ${workspacePath}`,
          404,
        );
      }

      throw new AtlasApiError(
        `Failed to load signal configuration: ${
          error instanceof Error ? error.message : String(error)
        }`,
        500,
      );
    }
  }

  /**
   * List jobs in a workspace
   */
  async listJobs(workspaceId: string): Promise<JobInfo[]> {
    const response = await this.makeRequest(
      `/api/workspaces/${workspaceId}/jobs`,
    );
    return z.array(JobInfoSchema).parse(response);
  }

  /**
   * List sessions in a specific workspace
   */
  async listWorkspaceSessions(
    workspaceId: string,
  ): Promise<WorkspaceSessionInfo[]> {
    const response = await this.makeRequest(
      `/api/workspaces/${workspaceId}/sessions`,
    );
    return z.array(WorkspaceSessionInfoSchema).parse(response);
  }

  // =================================================================
  // LIBRARY OPERATIONS
  // =================================================================

  /**
   * List library items
   */
  async listLibraryItems(
    query?: Partial<LibrarySearchQuery>,
  ): Promise<LibrarySearchResult> {
    const params = new URLSearchParams();
    if (query?.query) params.set("q", query.query);
    if (query?.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      params.set("type", types.join(","));
    }
    if (query?.tags) params.set("tags", query.tags.join(","));
    if (query?.since) params.set("since", query.since);
    if (query?.until) params.set("until", query.until);
    if (query?.limit) params.set("limit", query.limit.toString());
    if (query?.offset) params.set("offset", query.offset.toString());

    const queryString = params.toString();
    const path = queryString ? `/api/library?${queryString}` : "/api/library";

    const response = await this.makeRequest(path);
    return LibrarySearchResultSchema.parse(response);
  }

  /**
   * Get specific library item
   */
  async getLibraryItem(
    itemId: string,
    includeContent: boolean = false,
  ): Promise<LibraryItemWithContent> {
    const params = new URLSearchParams();
    if (includeContent) params.set("content", "true");

    const queryString = params.toString();
    const path = queryString ? `/api/library/${itemId}?${queryString}` : `/api/library/${itemId}`;

    const response = await this.makeRequest(path);
    return LibraryItemWithContentSchema.parse(response);
  }

  /**
   * Search library items
   */
  async searchLibrary(query: LibrarySearchQuery): Promise<LibrarySearchResult> {
    const params = new URLSearchParams();
    if (query.query) params.set("q", query.query);
    if (query.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      params.set("type", types.join(","));
    }
    if (query.tags) params.set("tags", query.tags.join(","));
    if (query.since) params.set("since", query.since);
    if (query.until) params.set("until", query.until);
    if (query.limit) params.set("limit", query.limit.toString());
    if (query.offset) params.set("offset", query.offset.toString());

    const queryString = params.toString();
    const path = `/api/library/search?${queryString}`;

    const response = await this.makeRequest(path);
    return LibrarySearchResultSchema.parse(response);
  }

  /**
   * List available templates
   */
  async listTemplates(): Promise<TemplateConfig[]> {
    const response = await this.makeRequest("/api/library/templates");
    return z.array(TemplateConfigSchema).parse(response);
  }

  /**
   * Generate content from template
   */
  async generateFromTemplate(
    templateId: string,
    data: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.makeRequest("/api/library/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        templateId,
        data,
        options,
      }),
    });
    return response;
  }

  /**
   * Get library statistics
   */
  async getLibraryStats(): Promise<LibraryStats> {
    const response = await this.makeRequest("/api/library/stats");
    return LibraryStatsSchema.parse(response);
  }

  /**
   * Delete library item
   */
  async deleteLibraryItem(itemId: string): Promise<DeleteLibraryItemResponse> {
    const response = await this.makeRequest(`/api/library/${itemId}`, {
      method: "DELETE",
    });
    return DeleteResponseSchema.parse(response);
  }

  /**
   * Shutdown the daemon
   */
  async shutdown(): Promise<{ message: string }> {
    const response = await this.makeRequest("/api/daemon/shutdown", {
      method: "POST",
    });
    return MessageResponseSchema.parse(response);
  }

  /**
   * Make a request to the Atlas API with error handling
   */
  private async makeRequest(
    path: string,
    options: RequestInit = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.url}${path}`, {
        signal: controller.signal,
        ...options,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorMessage: string;
        try {
          const errorData = await response.json();
          errorMessage = errorData.error ||
            `HTTP ${response.status}: ${response.statusText}`;
        } catch {
          errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        }
        throw new AtlasApiError(errorMessage, response.status);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof AtlasApiError) {
        throw error;
      }

      if (error.name === "AbortError") {
        throw new AtlasApiError(
          `Request to Atlas daemon timed out after ${this.timeout}ms. Is the daemon running?`,
          408,
        );
      }

      // Network errors
      throw new AtlasApiError(
        `Failed to connect to Atlas daemon at ${this.url}. Is the daemon running? Error: ${error.message}`,
        503,
      );
    }
  }

  /**
   * Handle fetch errors in a standardized way
   * Used by consumer code for consistent error handling
   */
  handleFetchError(error: unknown): {
    success: false;
    error: string;
    reason?: string;
  } {
    if (error instanceof AtlasApiError) {
      let reason: string | undefined;
      if (error.status === 503) {
        reason = "server_not_running";
      } else if (error.status >= 400 && error.status < 500) {
        reason = "api_error";
      } else {
        reason = "network_error";
      }

      return {
        success: false,
        error: error.message,
        reason,
      };
    }

    if (error instanceof Error) {
      return {
        success: false,
        error: error.message,
        reason: "network_error",
      };
    }

    return {
      success: false,
      error: String(error),
      reason: "network_error",
    };
  }
}

// Default client instance
let defaultClient: AtlasClient | null = null;

export function getAtlasClient(options?: AtlasClientOptions): AtlasClient {
  if (!defaultClient) {
    defaultClient = new AtlasClient(options);
  }
  return defaultClient;
}
