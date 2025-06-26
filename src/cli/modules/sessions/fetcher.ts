import { formatSessionForJson, type Session } from "./session-list-component.tsx";

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

// Fetch sessions from server API
export async function fetchSessions(
  options: SessionFetchOptions = {},
): Promise<SessionFetchResponse> {
  try {
    const port = options.port || 8080;
    const response = await fetch(`http://localhost:${port}/sessions`, {
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Failed to fetch sessions: ${response.statusText}`,
        reason: "api_error",
      };
    }

    const result = await response.json();
    const sessions = (result.sessions || []) as Session[];

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
    if (error instanceof Error) {
      // Check for connection refused (no server running)
      if (
        error.message.includes("Connection refused") ||
        (error.name === "TypeError" && error.message.includes("fetch"))
      ) {
        return {
          success: false,
          error: `No workspace server running. Start a workspace with 'atlas workspace serve'`,
          reason: "server_not_running",
        };
      }

      if (error.name === "AbortError") {
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
