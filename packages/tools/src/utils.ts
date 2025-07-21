/**
 * Shared utilities for Atlas AI SDK tools
 */

/**
 * Default daemon context for tools
 */
export const defaultContext = {
  daemonUrl: Deno.env.get("ATLAS_DAEMON_URL") || "http://localhost:8080",
};

/**
 * Helper to safely extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Fetch with timeout and enhanced error handling
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { timeout = 30000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timeout after ${timeout}ms: ${url}`);
    }

    throw error;
  }
}

/**
 * Handle daemon API response with enhanced error handling
 */
export async function handleDaemonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    let errorData: { message?: string; error?: string } = {};
    try {
      const text = await response.text();
      if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
        errorData = JSON.parse(text);
      } else {
        errorData = { message: text };
      }
    } catch {
      errorData = { message: response.statusText };
    }

    throw new Error(
      `Daemon API error: ${response.status} - ${
        errorData.error || errorData.message || response.statusText
      }`,
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(
      `Failed to parse daemon API response: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
