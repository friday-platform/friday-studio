/**
 * Utilities for conversation agent tools
 */

// Default context for daemon URL
export const defaultContext = {
  daemonUrl: Deno.env.get("ATLAS_DAEMON_URL") || "http://localhost:8080",
};

/**
 * Helper function for making HTTP requests with timeout
 * @deprecated Use @atlas/oapi-client instead
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const timeout = options.timeout || 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Handle daemon response and extract data
 * @deprecated Use @atlas/oapi-client which handles responses automatically
 */
export async function handleDaemonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error (${response.status}): ${errorText}`);
  }
  return await response.json();
}

/**
 * Helper to safely extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}