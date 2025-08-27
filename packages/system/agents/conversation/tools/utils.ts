/**
 * Determine if an HTTP status code indicates a retryable error
 */
export function isRetryableError(status: number): boolean {
  // Retry on server errors (5xx) and specific client errors
  return (
    status >= 500 || // Server errors
    status === 408 || // Request timeout
    status === 429 || // Too many requests
    status === 503 || // Service unavailable
    status === 504 // Gateway timeout
  );
}

/**
 * Calculate exponential backoff delay for retries
 */
export function calculateRetryDelay(retryCount: number): number {
  // Exponential backoff: 1s, 2s, 4s, 8s, etc. with jitter
  const baseDelay = 2 ** retryCount * 1000;
  const jitter = Math.random() * 0.3 * baseDelay; // 30% jitter
  return Math.min(baseDelay + jitter, 30000); // Cap at 30 seconds
}

/**
 * Simple sleep utility for retry delays
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with timeout and enhanced error handling
 *
 * Wrapper around fetch() with automatic timeout handling and enhanced error reporting.
 * Prevents hanging requests and provides detailed error context for troubleshooting.
 *
 * Features:
 * - Configurable request timeout (default: 30 seconds)
 * - Automatic request cancellation on timeout
 * - AbortController integration for clean cancellation
 * - Enhanced error messages with URL and timing context
 * - MCP-compliant error codes for timeout scenarios
 *
 * @param url - Target URL for the request
 * @param options - Fetch options (headers, method, body, etc.)
 * @param timeoutMs - Request timeout in milliseconds (default: 30000)
 * @returns HTTP Response object
 * @throws {Error} Timeout error with structured details
 * @throws {Error} Network errors (connection failed, DNS resolution, etc.)
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 30000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      const timeoutError = new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
      // deno-lint-ignore no-explicit-any
      timeoutError.code = -32000;
      // deno-lint-ignore no-explicit-any
      timeoutError.details = { url, timeoutMs, timestamp: new Date().toISOString() };
      throw timeoutError;
    }

    // Re-throw other errors (network, etc.)
    throw error;
  }
}
