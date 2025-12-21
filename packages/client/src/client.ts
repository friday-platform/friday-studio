/**
 * Atlas API client for CLI commands and other consumers
 * All CLI commands should use this to communicate with the Atlas daemon
 */

import { env } from "node:process";
import { parseResult, client as v2Client } from "@atlas/client/v2";
import { getDiagnosticsApiUrl, validateAtlasJWT } from "@atlas/core";
import { createAtlasClient } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { load } from "@std/dotenv";
import { exists } from "@std/fs";
import { basename, join } from "@std/path";
import z from "zod";
import { AtlasApiError } from "./errors.ts";
import type {
  AgentInfo,
  CancelSessionResponse,
  JobInfo,
  LibraryItemWithContent,
  LibrarySearchQuery,
  LibrarySearchResult,
  SessionDetailedInfo,
  SessionInfo,
  SignalTriggerResponse,
  WorkspaceAddRequest,
  WorkspaceBatchAddRequest,
  WorkspaceBatchAddResponse,
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceDetailedInfo,
  WorkspaceInfo,
  WorkspaceSessionInfo,
} from "./types/index.ts";

export class AtlasClient {
  /**
   * Get detailed workspace information
   */
  async getWorkspace(workspaceId: string): Promise<WorkspaceDetailedInfo> {
    const response = await parseResult(
      v2Client.workspace[":workspaceId"].$get({ param: { workspaceId } }),
    );
    if (!response.ok) {
      throw new Error(`Failed to get workspace: ${stringifyError(response.error)}`);
    }
    return response.data;
  }

  /**
   * Create a new workspace
   */
  async createWorkspace(request: WorkspaceCreateRequest): Promise<WorkspaceCreateResponse> {
    const response = await parseResult(v2Client.workspace.create.$post({ json: request }));
    if (!response.ok) {
      throw new Error(`Failed to add workspace: ${stringifyError(response.error)}`);
    }
    return response.data.workspace;
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
   * Add a single workspace by path
   */
  async addWorkspace(request: WorkspaceAddRequest): Promise<WorkspaceInfo> {
    const response = await parseResult(v2Client.workspace.add.$post({ json: request }));
    if (!response.ok) {
      throw new Error(`Failed to add workspace: ${stringifyError(response.error)}`);
    }
    return response.data;
  }

  /**
   * Add multiple workspaces by paths (batch operation)
   */
  async addWorkspaces(request: WorkspaceBatchAddRequest): Promise<WorkspaceBatchAddResponse> {
    const response = await parseResult(v2Client.workspace["add-batch"].$post({ json: request }));
    if (!response.ok) {
      throw new Error(`Failed to add workspaces: ${stringifyError(response.error)}`);
    }
    return response.data;
  }

  /**
   * Trigger a signal in a workspace
   */
  async triggerSignal(
    workspaceId: string,
    signalId: string,
    payload: Record<string, unknown> = {},
  ): Promise<SignalTriggerResponse> {
    const response = await parseResult(
      v2Client.workspace[":workspaceId"].signals[":signalId"].$post({
        param: { workspaceId, signalId },
        json: payload,
      }),
    );
    if (!response.ok) {
      throw new Error(`Failed to trigger signal: ${stringifyError(response.error)}`);
    }
    return response.data;
  }

  /**
   * List all sessions across workspaces
   */
  async listSessions(): Promise<SessionInfo[]> {
    const response = await parseResult(v2Client.sessions.index.$get());
    if (!response.ok) {
      throw new Error(`Failed to get session: ${stringifyError(response.error)}`);
    }
    return response.data;
  }

  /**
   * Get specific session details
   */
  async getSession(sessionId: string): Promise<SessionDetailedInfo> {
    const response = await parseResult(v2Client.sessions[":id"].$get({ param: { id: sessionId } }));
    if (!response.ok) {
      throw new Error(`Failed to get session: ${stringifyError(response.error)}`);
    }
    return response.data;
  }

  /**
   * Cancel a session
   */
  async cancelSession(sessionId: string): Promise<CancelSessionResponse> {
    const response = await parseResult(v2Client.sessions[":id"].$delete({ param: { sessionId } }));
    if (!response.ok) {
      throw new Error(`Failed to cancel session: ${stringifyError(response.error)}`);
    }
    return response.data;
  }

  /**
   * List agents in a workspace
   */
  async listAgents(workspaceId: string): Promise<AgentInfo[]> {
    const response = await parseResult(
      v2Client.workspace[":workspaceId"].agents.$get({ param: { workspaceId } }),
    );
    if (!response.ok) {
      throw new Error(
        `Failed to list agents in workspace ${workspaceId}: ${stringifyError(response.error)}`,
      );
    }

    return response.data;
  }

  /**
   * Describe a specific agent in a workspace
   */
  async describeAgent(workspaceId: string, agentId: string) {
    const response = await parseResult(
      v2Client.workspace[":workspaceId"].agents[":agentId"].$get({
        param: { agentId, workspaceId },
      }),
    );
    if (!response.ok) {
      throw new Error(
        `Failed to get agent ${agentId} in workspace ${workspaceId}: ${stringifyError(response.error)}`,
      );
    }

    return response.data;
  }

  /**
   * List signals in a workspace
   */
  async listSignals(workspaceId: string) {
    const response = await parseResult(
      v2Client.workspace[":workspaceId"].signals.$get({ param: { workspaceId } }),
    );

    if (!response.ok) {
      throw new Error(
        `Failed to list signals in workspace ${workspaceId}: ${stringifyError(response.error)}`,
      );
    }

    return response.data.signals;
  }

  /**
   * List jobs in a workspace
   */
  async listJobs(workspaceId: string): Promise<JobInfo[]> {
    const response = await parseResult(
      v2Client.workspace[":workspaceId"].jobs.$get({ param: { workspaceId } }),
    );
    if (!response.ok) {
      throw new Error(`Failed to list workspace sessions: ${stringifyError(response.error)}`);
    }
    return response.data;
  }

  /**
   * List sessions in a specific workspace
   */
  async listWorkspaceSessions(workspaceId: string): Promise<WorkspaceSessionInfo[]> {
    const response = await parseResult(
      v2Client.workspace[":workspaceId"].sessions.$get({ param: { workspaceId } }),
    );
    if (!response.ok) {
      throw new Error(`Failed to list workspace sessions: ${stringifyError(response.error)}`);
    }
    return response.data;
  }

  // =================================================================
  // LIBRARY OPERATIONS
  // =================================================================

  /**
   * List library items
   */
  async listLibraryItems(query?: Partial<LibrarySearchQuery>): Promise<LibrarySearchResult> {
    const q = {
      query: query?.query,
      type: Array.isArray(query?.type) ? query.type.join(",") : query?.type,
      tags: Array.isArray(query?.tags) ? query.tags.join(",") : query?.tags,
      since: query?.since,
      until: query?.until,
      limit: query?.limit,
      offset: query?.offset,
    };

    const client = createAtlasClient();
    const response = await client.GET("/api/library", { params: { query: q } });
    if (response.error) {
      throw new Error(stringifyError(response.error));
    }
    return response.data;
  }

  /**
   * Get specific library item
   */
  async getLibraryItem(
    itemId: string,
    includeContent: boolean = false,
  ): Promise<LibraryItemWithContent> {
    const client = createAtlasClient();
    const response = await client.GET("/api/library/{itemId}", {
      params: { query: { content: includeContent ? "true" : undefined }, path: { itemId } },
    });
    if (response.error) {
      throw new Error(stringifyError(response.error));
    }
    return response.data;
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
    const atlasKey = env.ATLAS_KEY;
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
        const errorDetails = z.object({ message: z.string() }).parse(error);
        if (errorDetails.message) {
          errorMessage = errorDetails.message;
        }
      } catch {
        // If JSON parsing fails, use status text
        errorMessage = `Failed to upload diagnostics: ${response.status} ${response.statusText}`;
      }
      throw new Error(errorMessage);
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

export function getAtlasClient(): AtlasClient {
  if (!defaultClient) {
    defaultClient = new AtlasClient();
  }
  return defaultClient;
}
