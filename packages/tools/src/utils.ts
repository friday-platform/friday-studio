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
 * Handle daemon API response with enhanced error handling and type safety
 *
 * @template T - The expected response type
 * @param response - The HTTP response from Atlas daemon
 * @returns Promise<T> - Parsed JSON response
 * @throws Error - On HTTP errors or invalid responses
 */
export async function handleDaemonResponse<T = unknown>(response: Response): Promise<T> {
  if (!response.ok) {
    let errorData: { message?: string; error?: string } = {};
    try {
      const text = await response.text();
      const trimmedText = text.trim();
      if (trimmedText.startsWith("{") || trimmedText.startsWith("[")) {
        errorData = JSON.parse(trimmedText);
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

  // Validate Content-Type for Atlas API consistency
  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    throw new Error(
      `Unexpected response format from daemon. Expected JSON, got: ${contentType || "unknown"}`,
    );
  }

  try {
    return await response.json() as T;
  } catch (error) {
    throw new Error(
      `Failed to parse daemon API response: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
