import { z } from "zod/v4";
import { LibraryItemSchema, type LibraryItem } from "./library-list-component.tsx";

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
  reason?: 'server_not_running' | 'api_error' | 'network_error';
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
    if (typeof options.workspace === 'boolean') {
      params.append("workspace", "true");
    } else {
      params.append("workspace", options.workspace);
    }
  }
  
  return params;
}

// Fetch library items from server API
export async function fetchLibraryItems(options: LibraryFetchOptions = {}): Promise<LibraryFetchResponse> {
  try {
    const port = options.port || 8080;
    const params = buildLibraryQueryParams(options);
    const serverUrl = `http://localhost:${port}`;
    
    const response = await fetch(`${serverUrl}/library?${params}`, {
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
        reason: 'api_error',
      };
    }

    const data = await response.json();
    const items = z.array(LibraryItemSchema).parse(data);

    return {
      success: true,
      items,
    };
  } catch (error) {
    if (error instanceof Error) {
      // Check for common network errors
      if (error.name === 'TypeError' && error.message.includes('fetch')) {
        return {
          success: false,
          error: `Cannot connect to server on port ${options.port || 8080}. Make sure the workspace server is running.`,
          reason: 'server_not_running',
        };
      }
      
      if (error.name === 'AbortError') {
        return {
          success: false,
          error: `Request timed out. Server may be unresponsive.`,
          reason: 'network_error',
        };
      }

      return {
        success: false,
        error: error.message,
        reason: 'network_error',
      };
    }

    return {
      success: false,
      error: String(error),
      reason: 'network_error',
    };
  }
}