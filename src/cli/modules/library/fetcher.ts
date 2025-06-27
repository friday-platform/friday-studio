import { z } from "zod/v4";
import { type LibraryItem, LibraryItemSchema } from "./library-list-component.tsx";
import { getAtlasClient, type LibrarySearchQuery } from "@atlas/client";

export interface LibraryFetchOptions {
  type?: string;
  tags?: string;
  since?: string;
  limit?: number;
  workspace?: string | boolean;
  port?: number;
}

export interface LibraryFetchResult {
  success: true;
  items: LibraryItem[];
}

export interface LibraryFetchError {
  success: false;
  error: string;
  reason?: "server_not_running" | "api_error" | "network_error";
}

export type LibraryFetchResponse = LibraryFetchResult | LibraryFetchError;

// Build query parameters for API call
export function buildLibraryQueryParams(options: LibraryFetchOptions): URLSearchParams {
  const params = new URLSearchParams();

  if (options.type) params.append("type", options.type);
  if (options.tags) params.append("tags", options.tags);
  if (options.since) params.append("since", options.since);
  if (options.limit) params.append("limit", options.limit.toString());
  if (options.workspace) {
    if (typeof options.workspace === "boolean") {
      params.append("workspace", "true");
    } else {
      params.append("workspace", options.workspace);
    }
  }

  return params;
}

// Fetch library items from server API
export async function fetchLibraryItems(
  options: LibraryFetchOptions = {},
): Promise<LibraryFetchResponse> {
  try {
    const client = getAtlasClient({
      url: `http://localhost:${options.port || 8080}`,
      timeout: 5000, // 5 second timeout
    });

    // Convert LibraryFetchOptions to LibrarySearchQuery format
    const searchQuery: LibrarySearchQuery = {
      type: options.type,
      tags: options.tags ? options.tags.split(",") : undefined,
      since: options.since,
      limit: options.limit,
    };

    // Handle workspace filter by adding it to the query string if needed
    // Note: The AtlasClient doesn't have a workspace parameter in LibrarySearchQuery,
    // so we'll need to handle this differently or update the API
    const result = await client.searchLibrary(searchQuery);

    // Convert the result to match the expected format
    const items = result.items.map((item): LibraryItem => ({
      id: item.id,
      type: item.type,
      name: item.name,
      description: item.description,
      created_at: item.created_at,
      tags: item.tags,
      size_bytes: item.size_bytes,
    }));

    return {
      success: true,
      items,
    };
  } catch (error) {
    if (error instanceof Error) {
      // Check for common network errors
      if (
        error.message.includes("Connection refused") ||
        error.message.includes("Failed to connect to Atlas")
      ) {
        return {
          success: false,
          error: `Cannot connect to server on port ${
            options.port || 8080
          }. Make sure the workspace server is running.`,
          reason: "server_not_running",
        };
      }

      if (error.message.includes("timed out")) {
        return {
          success: false,
          error: `Request timed out. Server may be unresponsive.`,
          reason: "network_error",
        };
      }

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
