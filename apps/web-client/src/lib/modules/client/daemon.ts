/**
 * Daemon API client for CLI commands
 * All CLI commands should use this to communicate with the daemon
 */

import type { LibraryItem } from "@atlas/core/library";
import { createAtlasClient } from "@atlas/oapi-client";
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
      limit: query?.limit?.toString(),
      offset: query?.offset?.toString(),
    };

    const client = createAtlasClient();
    const response = await client.GET("/api/library", { params: { query: q } });
    if (response.error) {
      throw new Error(stringifyError(response.error));
    }
    return response.data;
  }
}
