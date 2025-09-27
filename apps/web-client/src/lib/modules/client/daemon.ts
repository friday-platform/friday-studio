/**
 * Daemon API client for CLI commands
 * All CLI commands should use this to communicate with the daemon
 */

import type { LibraryItem, StoreItemInput } from "../../../../../../src/core/library/types.ts";

interface DaemonClientOptions {
  daemonUrl: string;
  timeout?: number;
}

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
  private daemonUrl: string;
  private timeout: number;

  constructor(options: DaemonClientOptions) {
    this.daemonUrl = options.daemonUrl;
    this.timeout = options.timeout || 10000; // 10 seconds
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
    return response;
  }

  /**
   * Create library item from File upload
   * Web clients upload files directly - all metadata extracted from File object
   */
  async createLibraryItem(
    file: File,
  ): Promise<{
    success: boolean;
    itemId: string;
    message: string;
    item: StoreItemInput;
    path: string;
  }> {
    const formData = new FormData();
    formData.append("file", file);

    const response = await this.makeRequest("/api/library", {
      method: "POST",
      body: formData, // FormData sets Content-Type automatically
    });
    return response;
  }

  /**
   * Make a request to the daemon API with error handling
   */
  private async makeRequest(path: string, options: RequestInit = {}): Promise<unknown> {
    try {
      // Try the request first
      return await this.makeRequestInternal(path, options);
    } catch (error) {
      // If it's a connection error, provide a helpful message
      if (error instanceof DaemonApiError && error.status === 503) {
        // Replace the technical error with a user-friendly message
        throw new DaemonApiError(
          "Atlas daemon is not running. Please start it manually with 'atlas service start'",
          503,
        );
      }

      throw error;
    }
  }

  /**
   * Internal request method without auto-start logic
   */
  private async makeRequestInternal(path: string, options: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.daemonUrl}${path}`, {
        signal: controller.signal,
        ...options,
        headers: { ...(options?.headers ?? {}) },
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

      if (error instanceof Error && error.name === "AbortError") {
        throw new DaemonApiError(
          `Request to daemon timed out after ${this.timeout}ms. Is the daemon running?`,
          408,
        );
      }

      // Network errors
      throw new DaemonApiError(
        `Failed to connect to daemon at ${this.daemonUrl}. Is the daemon running? Error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        503,
      );
    }
  }
}

class DaemonApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "DaemonApiError";
  }
}
