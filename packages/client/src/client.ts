/**
 * Atlas API client for CLI commands and other consumers
 * All CLI commands should use this to communicate with the Atlas daemon
 */

import { getAtlasDaemonUrl } from "@atlas/atlasd";
import { getDiagnosticsApiUrl, validateAtlasJWT } from "@atlas/core";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { load } from "@std/dotenv";
import { exists } from "@std/fs";
import { basename, join } from "@std/path";
import * as yaml from "@std/yaml";
import { z } from "zod/v4";
import { DEFAULT_TIMEOUT } from "./constants.ts";
import { AtlasApiError } from "./errors.ts";
import {
  AgentInfoSchema,
  CancelSessionResponseSchema,
  CreateWorkspaceFromTemplateRequestSchema,
  CreateWorkspaceFromTemplateResponseSchema,
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
  WorkspaceAddRequestSchema,
  WorkspaceBatchAddRequestSchema,
  WorkspaceBatchAddResponseSchema,
  WorkspaceCreateResponseSchema,
  WorkspaceDetailedInfoSchema,
  WorkspaceInfoSchema,
  WorkspaceSessionInfoSchema,
  WorkspaceTemplateListResponseSchema,
} from "./schemas.ts";
import type {
  AgentInfo,
  AtlasClientOptions,
  CancelSessionResponse,
  CreateWorkspaceFromTemplateRequest,
  CreateWorkspaceFromTemplateResponse,
  DaemonStatus,
  DeleteLibraryItemResponse,
  JobDetailedInfo,
  JobInfo,
  LibraryItemWithContent,
  LibrarySearchQuery,
  LibrarySearchResult,
  LibraryStats,
  LogEntry,
  SessionDetailedInfo,
  SessionInfo,
  SignalDetailedInfo,
  SignalResponse,
  SignalTriggerResponse,
  TemplateConfig,
  WorkspaceAddRequest,
  WorkspaceBatchAddRequest,
  WorkspaceBatchAddResponse,
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceDetailedInfo,
  WorkspaceInfo,
  WorkspaceSessionInfo,
  WorkspaceTemplateInfo,
} from "./types/index.ts";

export class AtlasClient {
  private url: string;
  private timeout: number;

  constructor(options: AtlasClientOptions = {}) {
    this.url = options.url || getAtlasDaemonUrl();
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  /**
   * Check if Atlas daemon is running and accessible
   */
  async isHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.url}/health`, { signal: controller.signal });

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
  async createWorkspace(request: WorkspaceCreateRequest): Promise<WorkspaceCreateResponse> {
    const response = await this.makeRequest("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    return WorkspaceCreateResponseSchema.parse(response);
  }

  /**
   * Delete a workspace
   */
  async deleteWorkspace(workspaceId: string, force: boolean = false): Promise<{ message: string }> {
    const url = new URL(`${this.url}/api/workspaces/${workspaceId}`);
    if (force) {
      url.searchParams.set("force", "true");
    }

    const response = await this.makeRequest(url.pathname + url.search, { method: "DELETE" });
    return MessageResponseSchema.parse(response);
  }

  /**
   * Add a single workspace by path
   */
  async addWorkspace(request: WorkspaceAddRequest): Promise<WorkspaceInfo> {
    const response = await this.makeRequest("/api/workspaces/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(WorkspaceAddRequestSchema.parse(request)),
    });
    return WorkspaceInfoSchema.parse(response);
  }

  /**
   * Add multiple workspaces by paths (batch operation)
   */
  async addWorkspaces(request: WorkspaceBatchAddRequest): Promise<WorkspaceBatchAddResponse> {
    const response = await this.makeRequest("/api/workspaces/add-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(WorkspaceBatchAddRequestSchema.parse(request)),
    });
    return WorkspaceBatchAddResponseSchema.parse(response);
  }

  /**
   * List available workspace templates
   */
  async listWorkspaceTemplates(): Promise<WorkspaceTemplateInfo[]> {
    const response = await this.makeRequest("/api/templates");
    return WorkspaceTemplateListResponseSchema.parse(response);
  }

  /**
   * Create a new workspace from a template
   */
  async createWorkspaceFromTemplate(
    request: CreateWorkspaceFromTemplateRequest,
  ): Promise<CreateWorkspaceFromTemplateResponse> {
    const response = await this.makeRequest("/api/workspaces/create-from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(CreateWorkspaceFromTemplateRequestSchema.parse(request)),
    });
    return CreateWorkspaceFromTemplateResponseSchema.parse(response);
  }

  /**
   * Create a new workspace from a configuration YAML
   */
  async createWorkspaceFromConfig(params: {
    name: string;
    description: string;
    config: string;
    path?: string;
  }): Promise<WorkspaceCreateResponse> {
    const response = await this.makeRequest("/api/workspaces/create-from-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return WorkspaceCreateResponseSchema.parse(response);
  }

  /**
   * Trigger a signal in a workspace
   */
  async triggerSignal(
    workspaceId: string,
    signalId: string,
    payload: Record<string, unknown> = {},
  ): Promise<SignalTriggerResponse> {
    const response = await this.makeRequest(`/api/workspaces/${workspaceId}/signals/${signalId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
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
      const response = await fetch(`http://localhost:${port}/signals/${signalName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

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

      if (error instanceof Error && error.name === "AbortError") {
        throw new AtlasApiError(
          `Request to workspace server timed out after ${this.timeout}ms`,
          408,
        );
      }

      throw new AtlasApiError(
        `Failed to connect to workspace server on port ${port}. Error: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
    const response = await this.makeRequest(`/api/sessions/${sessionId}`, { method: "DELETE" });
    return CancelSessionResponseSchema.parse(response);
  }

  /**
   * Get session logs
   */
  async getSessionLogs(
    sessionId: string,
    options?: { tail?: number; follow?: boolean; filter?: string },
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
    options?: { tail?: number; filter?: string },
  ): AsyncIterableIterator<LogEntry> {
    const params = new URLSearchParams();
    if (options?.tail) params.set("tail", options.tail.toString());
    if (options?.filter) params.set("filter", options.filter);
    params.set("stream", "true");

    const queryString = params.toString();
    const path = `/sessions/${sessionId}/logs?${queryString}`;

    const response = await fetch(`${this.url}${path}`, {
      headers: { Accept: "text/event-stream" },
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
              yield data;
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
    const response = await this.makeRequest(`/api/workspaces/${workspaceId}/agents`);
    return z.array(AgentInfoSchema).parse(response);
  }

  /**
   * Describe a specific agent in a workspace
   */
  async describeAgent(workspaceId: string, agentId: string): Promise<unknown> {
    const response = await this.makeRequest(`/api/workspaces/${workspaceId}/agents/${agentId}`);
    return response;
  }

  /**
   * List signals in a workspace
   */
  async listSignals(workspaceId: string) {
    const response = await this.makeRequest(`/api/workspaces/${workspaceId}/signals`);

    return z.record(z.string(), SignalInfoSchema).parse(response);
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
    const signal = signals[signalName] ?? undefined;

    if (!signal) {
      throw new AtlasApiError(`Signal '${signalName}' not found in workspace`, 404);
    }

    // Load signal configuration directly using provided workspace path
    const signalConfig = await this.loadSignalConfig(workspacePath, signalName);

    // Return without schema validation for now to avoid Zod issues
    return signalConfig;
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
      const workspaceYmlPath = `${workspacePath}/workspace.yml`;
      const yamlContent = await Deno.readTextFile(workspaceYmlPath);
      const rawConfig = yaml.parse(yamlContent);

      // Extract signal configuration (signals can be at root or under workspace)
      const workspace = rawConfig.workspace;
      const signals = (workspace?.signals || rawConfig.signals) as
        | Record<string, unknown>
        | undefined;
      const signalConfig = signals?.[signalName];

      if (!signalConfig) {
        throw new AtlasApiError(`Signal '${signalName}' configuration not found`, 404);
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
        throw new AtlasApiError(`Workspace configuration file not found at ${workspacePath}`, 404);
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
   * Load job configuration from workspace.yml without triggering workspace validation
   * Private method to support describeJob
   */
  private async loadJobConfig(
    workspacePath: string,
    jobName: string,
  ): Promise<Record<string, unknown>> {
    // Load raw YAML without full ConfigLoader validation to avoid agent/job validation
    try {
      // Read and parse workspace.yml directly to avoid validation issues
      const workspaceYmlPath = `${workspacePath}/workspace.yml`;
      const yamlContent = await Deno.readTextFile(workspaceYmlPath);
      const rawConfig = yaml.parse(yamlContent);

      // Extract job configuration from workspace.yml (jobs can be at root or under workspace)
      const workspace = rawConfig.workspace;
      const jobs = workspace?.jobs || rawConfig.jobs;
      const jobConfig = jobs?.[jobName];

      if (!jobConfig) {
        throw new AtlasApiError(`Job '${jobName}' configuration not found`, 404);
      }

      // Ensure required fields for JobDetailedInfo schema
      const detailedConfig = {
        name: jobConfig.name || jobName,
        description: jobConfig.description,
        task_template: jobConfig.task_template,
        triggers: jobConfig.triggers,
        session_prompts: jobConfig.session_prompts,
        execution: jobConfig.execution,
        success_criteria: jobConfig.success_criteria,
        error_handling: jobConfig.error_handling,
        resources: jobConfig.resources,
      };

      return detailedConfig;
    } catch (error) {
      if (error instanceof AtlasApiError) {
        throw error;
      }

      // Handle file not found errors specifically
      if (error instanceof Deno.errors.NotFound) {
        throw new AtlasApiError(`Workspace configuration file not found at ${workspacePath}`, 404);
      }

      throw new AtlasApiError(
        `Failed to load job configuration: ${
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
    const response = await this.makeRequest(`/api/workspaces/${workspaceId}/jobs`);
    return z.array(JobInfoSchema).parse(response);
  }

  /**
   * Describe a specific job in a workspace
   * Note: This loads configuration directly without triggering workspace validation
   */
  async describeJob(
    workspaceId: string,
    jobName: string,
    workspacePath: string,
  ): Promise<JobDetailedInfo> {
    // First verify the job exists
    const jobs = await this.listJobs(workspaceId);
    const job = jobs.find((j) => j.name === jobName);

    if (!job) {
      throw new AtlasApiError(`Job '${jobName}' not found in workspace`, 404);
    }

    // Load job configuration directly using provided workspace path
    const jobConfig = await this.loadJobConfig(workspacePath, jobName);

    // Return without schema validation for now to avoid Zod issues
    return jobConfig;
  }

  /**
   * List sessions in a specific workspace
   */
  async listWorkspaceSessions(workspaceId: string): Promise<WorkspaceSessionInfo[]> {
    const response = await this.makeRequest(`/api/workspaces/${workspaceId}/sessions`);
    return z.array(WorkspaceSessionInfoSchema).parse(response);
  }

  // =================================================================
  // LIBRARY OPERATIONS
  // =================================================================

  /**
   * List library items
   */
  async listLibraryItems(query?: Partial<LibrarySearchQuery>): Promise<LibrarySearchResult> {
    const params = new URLSearchParams();
    if (query?.query) params.set("q", query.query);
    if (query?.source) {
      const sources = Array.isArray(query.source) ? query.source : [query.source];
      params.set("source", sources.join(","));
    }
    if (query?.tags) params.set("tags", query.tags.join(","));
    if (query?.workspace) params.set("workspace", query.workspace.toString());
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
    if (query.source) {
      const sources = Array.isArray(query.source) ? query.source : [query.source];
      params.set("source", sources.join(","));
    }
    if (query.tags) params.set("tags", query.tags.join(","));
    if (query.workspace) params.set("workspace", query.workspace.toString());
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId, data, options }),
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
    const response = await this.makeRequest(`/api/library/${itemId}`, { method: "DELETE" });
    return DeleteResponseSchema.parse(response);
  }

  // =================================================================
  // WORKSPACE-SPECIFIC LIBRARY OPERATIONS
  // =================================================================

  /**
   * List library items in a specific workspace
   */
  async listWorkspaceLibraryItems(
    workspaceId: string,
    query?: Partial<LibrarySearchQuery>,
  ): Promise<LibrarySearchResult> {
    const params = new URLSearchParams();
    if (query?.query) params.set("q", query.query);
    if (query?.source) {
      const sources = Array.isArray(query.source) ? query.source : [query.source];
      params.set("source", sources.join(","));
    }
    if (query?.tags) params.set("tags", query.tags.join(","));
    if (query?.workspace) params.set("workspace", query.workspace.toString());
    if (query?.since) params.set("since", query.since);
    if (query?.until) params.set("until", query.until);
    if (query?.limit) params.set("limit", query.limit.toString());
    if (query?.offset) params.set("offset", query.offset.toString());

    const queryString = params.toString();
    const path = queryString
      ? `/api/workspaces/${workspaceId}/library?${queryString}`
      : `/api/workspaces/${workspaceId}/library`;

    const response = await this.makeRequest(path);
    return LibrarySearchResultSchema.parse(response);
  }

  /**
   * Search library items within a specific workspace
   */
  async searchWorkspaceLibrary(
    workspaceId: string,
    query: LibrarySearchQuery,
  ): Promise<LibrarySearchResult> {
    const params = new URLSearchParams();
    if (query.query) params.set("q", query.query);
    if (query.source) {
      const sources = Array.isArray(query.source) ? query.source : [query.source];
      params.set("source", sources.join(","));
    }
    if (query.tags) params.set("tags", query.tags.join(","));
    if (query.workspace) params.set("workspace", query.workspace.toString());
    if (query.since) params.set("since", query.since);
    if (query.until) params.set("until", query.until);
    if (query.limit) params.set("limit", query.limit.toString());
    if (query.offset) params.set("offset", query.offset.toString());

    const queryString = params.toString();
    const path = `/api/workspaces/${workspaceId}/library/search?${queryString}`;

    const response = await this.makeRequest(path);
    return LibrarySearchResultSchema.parse(response);
  }

  /**
   * Get specific library item from a workspace
   */
  async getWorkspaceLibraryItem(
    workspaceId: string,
    itemId: string,
    includeContent: boolean = false,
  ): Promise<LibraryItemWithContent> {
    const params = new URLSearchParams();
    if (includeContent) params.set("content", "true");

    const queryString = params.toString();
    const path = queryString
      ? `/api/workspaces/${workspaceId}/library/${itemId}?${queryString}`
      : `/api/workspaces/${workspaceId}/library/${itemId}`;

    const response = await this.makeRequest(path);
    return LibraryItemWithContentSchema.parse(response);
  }

  /**
   * Send diagnostic information to Atlas developers
   */
  async sendDiagnostics(gzipPath: string): Promise<void> {
    // Load .env from Atlas home directory first
    const globalAtlasEnv = join(getAtlasHome(), ".env");
    if (await exists(globalAtlasEnv)) {
      await load({ export: true, envPath: globalAtlasEnv });
    }

    // Get ATLAS_KEY from environment (either from .env or env variable)
    const atlasKey = Deno.env.get("ATLAS_KEY");
    if (!atlasKey) {
      throw new Error(
        "ATLAS_KEY not found. Please set it in ~/.atlas/.env or as an environment variable.",
      );
    }

    // Validate JWT token
    validateAtlasJWT(atlasKey);

    // Read the gzip file
    const diagnosticData = await Deno.readFile(gzipPath);

    // Get filename from path (handle both Unix and Windows paths)
    const filename = basename(gzipPath);

    // Send to diagnostic endpoint using centralized URL function
    const response = await fetch(getDiagnosticsApiUrl(filename), {
      method: "POST",
      headers: { Authorization: `Bearer ${atlasKey}`, "Content-Type": "application/gzip" },
      body: diagnosticData,
    });

    if (!response.ok) {
      let errorMessage = "Failed to upload diagnostics";
      try {
        const error = await response.json();
        if (error.message) {
          errorMessage = error.message;
        }
      } catch {
        // If JSON parsing fails, use status text
        errorMessage = `Failed to upload diagnostics: ${response.status} ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }
  }

  /**
   * Shutdown the daemon
   */
  async shutdown(): Promise<{ message: string }> {
    const response = await this.makeRequest("/api/daemon/shutdown", { method: "POST" });
    return MessageResponseSchema.parse(response);
  }

  /**
   * Make a request to the Atlas API with error handling
   */
  private async makeRequest(path: string, options: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.url}${path}`, { signal: controller.signal, ...options });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorMessage: string;
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || `HTTP ${response.status}: ${response.statusText}`;
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

      if (error instanceof Error && error.name === "AbortError") {
        throw new AtlasApiError(
          `Request to Atlas daemon timed out after ${this.timeout}ms. Is the daemon running?`,
          408,
        );
      }

      // Network errors
      throw new AtlasApiError(
        `Failed to connect to Atlas daemon at ${this.url}. Is the daemon running? Error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        503,
      );
    }
  }

  /**
   * Handle fetch errors in a standardized way
   * Used by consumer code for consistent error handling
   */
  handleFetchError(error: unknown): { success: false; error: string; reason?: string } {
    if (error instanceof AtlasApiError) {
      let reason: string | undefined;
      if (error.status === 503) {
        reason = "server_not_running";
      } else if (error.status >= 400 && error.status < 500) {
        reason = "api_error";
      } else {
        reason = "network_error";
      }

      return { success: false, error: error.message, reason };
    }

    if (error instanceof Error) {
      return { success: false, error: error.message, reason: "network_error" };
    }

    return { success: false, error: String(error), reason: "network_error" };
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

/**
 * Reset the default client instance.
 *
 * ⚠️ WARNING: This function is intended for testing purposes only.
 * It should not be used in production code.
 *
 * This is a temporary solution to address test isolation issues
 * while architectural improvements are being discussed.
 *
 * @internal
 */
export function resetAtlasClientForTesting(): void {
  defaultClient = null;
}
