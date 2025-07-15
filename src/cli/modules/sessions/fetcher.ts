import { formatSessionForJson, type Session } from "./session-list-component.tsx";
import { AtlasApiError, getAtlasClient, type SessionInfo } from "@atlas/client";

export interface SessionFetchOptions {
  workspace?: string;
  port?: number;
}

export interface SessionFetchResult {
  success: true;
  sessions: Session[];
  filteredSessions: Session[];
}

export interface SessionFetchError {
  success: false;
  error: string;
  reason?: "server_not_running" | "api_error" | "network_error";
}

export type SessionFetchResponse = SessionFetchResult | SessionFetchError;

// Fetch sessions from daemon API
export async function fetchSessions(
  options: SessionFetchOptions = {},
): Promise<SessionFetchResponse> {
  try {
    const client = getAtlasClient({
      url: `http://localhost:${options.port || 8080}`,
      timeout: 5000, // 5 second timeout
    });

    const sessionInfos = await client.listSessions();

    // Convert SessionInfo[] to Session[] format expected by the UI
    const sessions = sessionInfos.map((s: SessionInfo): Session => ({
      id: s.id,
      workspaceName: s.workspaceId, // Map workspaceId to workspaceName
      signal: s.signal,
      status: s.status,
      startedAt: s.startTime,
      completedAt: s.endTime,
      // Note: SessionInfo doesn't have agents info, so we'll omit it
    }));

    // Filter by workspace if specified
    const filteredSessions = options.workspace
      ? sessions.filter((s) => s.workspaceName === options.workspace)
      : sessions;

    return {
      success: true,
      sessions,
      filteredSessions,
    };
  } catch (error) {
    if (error instanceof AtlasApiError) {
      // Handle AtlasApiError with status codes
      if (error.status === 503) {
        return {
          success: false,
          error: `No workspace server running. Start a workspace with 'atlas workspace serve'`,
          reason: "server_not_running",
        };
      }

      if (error.status >= 400 && error.status < 500) {
        return {
          success: false,
          error: error.message,
          reason: "api_error",
        };
      }

      return {
        success: false,
        error: error.message,
        reason: "network_error",
      };
    }

    if (error instanceof Error) {
      // Check for connection refused (no server running)
      if (
        error.message.includes("Connection refused") ||
        error.message.includes("Failed to connect to Atlas")
      ) {
        return {
          success: false,
          error: `No workspace server running. Start a workspace with 'atlas workspace serve'`,
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

// Export formatted sessions for JSON output
export function formatSessionsForJson(sessions: Session[]) {
  return {
    sessions: sessions.map(formatSessionForJson),
    count: sessions.length,
  };
}
