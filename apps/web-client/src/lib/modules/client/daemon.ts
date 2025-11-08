/**
 * Daemon API client for CLI commands
 * All CLI commands should use this to communicate with the daemon
 */

import type { LibraryItem } from "@atlas/core/library";
import { createAtlasClient, getAtlasDaemonUrl } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";

interface LibrarySearchQuery {
  query?: string;
  type?: string | string[];
  tags?: string[];
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

interface LibrarySearchResult {
  items: LibraryItem[];
  total: number;
  query: LibrarySearchQuery;
  took_ms: number;
}

export class DaemonClient {
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

  // =================================================================
  // CONFIG OPERATIONS
  // =================================================================

  /**
   * Get environment variables from ~/.atlas/.env
   */
  async getEnvVars(): Promise<Record<string, string>> {
    const response = await fetch(`${getAtlasDaemonUrl()}/api/config/env`);
    if (!response.ok) {
      throw new Error(`Failed to get env vars: ${response.statusText}`);
    }
    const json = (await response.json()) as {
      success: boolean;
      envVars?: Record<string, string>;
      error?: string;
    };

    if (json.success) {
      return json.envVars || {};
    }

    throw new Error(json.error || "Failed to get env vars");
  }

  /**
   * Write environment variables to ~/.atlas/.env
   */
  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    const response = await fetch(`${getAtlasDaemonUrl()}/api/config/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envVars }),
    });
    if (!response.ok) {
      throw new Error(`Failed to set env vars: ${response.statusText}`);
    }
    const json = (await response.json()) as { success: boolean; error?: string };

    if (!json.success) {
      throw new Error(json.error || "Failed to set env vars");
    }
  }
}
