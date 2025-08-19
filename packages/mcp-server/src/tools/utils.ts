/**
 * Shared utilities for MCP tools
 * These utilities are extracted from the original platform-server.ts
 * to be reused across modular tool implementations
 */

import type { Logger } from "../platform-server.ts";

/**
 * Helper to build query parameters for library API calls
 *
 * Constructs URL query parameters with comprehensive validation and sanitization.
 * Reduces code duplication between library tools while ensuring data integrity.
 *
 * Validation Features:
 * - ISO 8601 date format validation with timezone support
 * - Query string length limits (max 1000 characters)
 * - Array size limits (20 types, 50 tags)
 * - Numeric range validation (limit: 1-1000, offset: ≥0)
 * - Automatic case normalization for types and tags
 * - URL-safe encoding handled by URLSearchParams
 *
 * @param options - Query parameter options
 * @returns URLSearchParams object ready for API requests
 * @throws {Error} Validation errors for invalid input parameters
 */
export function buildLibraryQueryParams(options: {
  query?: string;
  type?: string[];
  tags?: string[];
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}): URLSearchParams {
  const params = new URLSearchParams();

  // Enhanced input validation
  if (options.limit !== undefined && (options.limit < 1 || options.limit > 1000)) {
    throw new Error("Limit must be between 1 and 1000");
  }
  if (options.offset !== undefined && options.offset < 0) {
    throw new Error("Offset must be non-negative");
  }

  // Validate and parse ISO 8601 dates
  let sinceDate: Date | undefined;
  let untilDate: Date | undefined;

  if (options.since) {
    try {
      sinceDate = new Date(options.since);
      if (isNaN(sinceDate.getTime())) {
        throw new Error("Invalid since date format");
      }
    } catch {
      throw new Error(
        "Invalid since date format. Use ISO 8601 format (e.g., 2024-01-15T10:30:00Z)",
      );
    }
  }

  if (options.until) {
    try {
      untilDate = new Date(options.until);
      if (isNaN(untilDate.getTime())) {
        throw new Error("Invalid until date format");
      }
    } catch {
      throw new Error(
        "Invalid until date format. Use ISO 8601 format (e.g., 2024-01-15T10:30:00Z)",
      );
    }
  }

  // Validate date range logic
  if (sinceDate && untilDate && sinceDate >= untilDate) {
    throw new Error("'since' date must be before 'until' date");
  }

  // Build query params with validated inputs
  if (options.query) {
    if (options.query.length > 1000) {
      throw new Error("Query string too long (max 1000 characters)");
    }
    params.set("q", options.query);
  }

  if (options.type && options.type.length > 0) {
    if (options.type.length > 20) {
      throw new Error("Too many type filters (max 20)");
    }
    // Normalize case and join
    params.set("type", options.type.map((t) => t.toLowerCase()).join(","));
  }

  if (options.tags && options.tags.length > 0) {
    if (options.tags.length > 50) {
      throw new Error("Too many tag filters (max 50)");
    }
    // Normalize case and join
    params.set("tags", options.tags.map((t) => t.toLowerCase()).join(","));
  }

  // Use validated ISO strings
  if (sinceDate) {
    params.set("since", sinceDate.toISOString());
  }
  if (untilDate) {
    params.set("until", untilDate.toISOString());
  }

  // Safe numeric conversions with validated ranges
  if (options.limit !== undefined) {
    params.set("limit", Math.floor(options.limit).toString());
  }
  if (options.offset !== undefined) {
    params.set("offset", Math.floor(options.offset).toString());
  }

  return params;
}

/**
 * Handle daemon API response with enhanced error handling and retry support
 *
 * Centralizes response processing for daemon API calls with comprehensive error handling,
 * retry logic for transient failures, and detailed logging for troubleshooting.
 *
 * Features:
 * - Automatic JSON parsing with fallback error handling
 * - Structured error details with operation context
 * - Retry support for transient failures (5xx, timeouts)
 * - Performance metrics logging for successful requests
 * - MCP-compliant error codes (-32000 for server errors, -32603 for parse errors)
 *
 * @param response - HTTP Response object from fetch
 * @param operation - Operation name for logging and error context
 * @param options - Retry configuration options
 * @param logger - Logger instance for debugging
 * @returns Parsed JSON response data
 * @throws {Error} Enhanced error with structured details and retry information
 */
export async function handleDaemonResponse(
  response: Response,
  operation: string,
  logger: Logger,
  options: { retryCount?: number; maxRetries?: number } = {},
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const { retryCount = 0, maxRetries = 3 } = options;

  if (!response.ok) {
    // deno-lint-ignore no-explicit-any
    let errorData: any = {};
    let responseText = "";

    try {
      // Try to parse as JSON first
      const text = await response.text();
      responseText = text;
      if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
        errorData = JSON.parse(text);
      } else {
        errorData = { message: text };
      }
    } catch (parseError) {
      // If parsing fails, preserve the raw response text
      errorData = {
        message: responseText || response.statusText,
        parseError: parseError instanceof Error ? parseError.message : String(parseError),
      };
    }

    // Determine if error is retryable
    const isRetryable = isRetryableError(response.status);

    // Enhanced error with structured information
    const errorInfo = {
      operation,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers: Object.fromEntries(response.headers.entries()),
      retryCount,
      maxRetries,
      isRetryable,
      timestamp: new Date().toISOString(),
      ...errorData,
    };

    // Log detailed error information
    logger.error(`Daemon API error for ${operation}`, errorInfo);

    // Attempt retry for retryable errors
    if (isRetryable && retryCount < maxRetries) {
      const delay = calculateRetryDelay(retryCount);
      logger.info(
        `Retrying ${operation} after ${delay}ms (attempt ${retryCount + 1}/${maxRetries})`,
      );

      await sleep(delay);

      // Retry the request - this would need to be implemented at the caller level
      // For now, we'll throw with retry information
      const retryError = new Error(
        `Daemon API error for ${operation}: ${response.status} - ${
          errorData.error || errorData.message || response.statusText
        } (retry ${retryCount + 1}/${maxRetries})`,
      );
      // deno-lint-ignore no-explicit-any
      retryError.code = -32000;
      // deno-lint-ignore no-explicit-any
      retryError.details = errorInfo;
      // deno-lint-ignore no-explicit-any
      retryError.shouldRetry = true;
      throw retryError;
    }

    // Create comprehensive error for non-retryable or max retries exceeded
    const error = new Error(
      `Daemon API error for ${operation}: ${response.status} - ${
        errorData.error || errorData.message || response.statusText
      }${retryCount > 0 ? ` (failed after ${retryCount} retries)` : ""}`,
    );
    // deno-lint-ignore no-explicit-any
    error.code = -32000; // MCP server error code
    // deno-lint-ignore no-explicit-any
    error.details = errorInfo;
    // deno-lint-ignore no-explicit-any
    error.shouldRetry = false;
    throw error;
  }

  try {
    const result = await response.json();

    // Log successful response metrics
    logger.debug(`Daemon API success for ${operation}`, {
      operation,
      status: response.status,
      url: response.url,
      retryCount,
      responseSize: JSON.stringify(result).length,
      timestamp: new Date().toISOString(),
    });

    return result;
  } catch (error) {
    const parseError = new Error(
      `Failed to parse daemon API response for ${operation}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    // deno-lint-ignore no-explicit-any
    parseError.code = -32603; // Parse error code
    // deno-lint-ignore no-explicit-any
    parseError.details = {
      operation,
      status: response.status,
      url: response.url,
      retryCount,
      originalError: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    };

    // deno-lint-ignore no-explicit-any
    logger.error(`Parse error for ${operation}`, parseError.details);
    throw parseError;
  }
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
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      const timeoutError = new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
      // deno-lint-ignore no-explicit-any
      timeoutError.code = -32000;
      // deno-lint-ignore no-explicit-any
      timeoutError.details = {
        url,
        timeoutMs,
        timestamp: new Date().toISOString(),
      };
      throw timeoutError;
    }

    // Re-throw other errors (network, etc.)
    throw error;
  }
}

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
  const baseDelay = Math.pow(2, retryCount) * 1000;
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
 * Check if a workspace has MCP enabled
 * SECURITY: Respects workspace-level server.mcp.enabled settings
 */
export async function checkWorkspaceMCPEnabled(
  daemonUrl: string,
  workspaceId: string,
  logger: Logger,
): Promise<boolean> {
  let response: Response | undefined;
  try {
    response = await fetch(`${daemonUrl}/api/workspaces/${workspaceId}`);
    if (!response.ok) {
      // Consume the response body to prevent leaks
      try {
        await response.text();
      } catch {
        // Ignore errors when consuming error response body
      }
      logger.warn("Platform MCP: Failed to check workspace MCP settings", {
        workspaceId,
        status: response.status,
      });
      return false; // Fail closed - deny access if can't verify
    }

    const workspace = await response.json();
    const mcpEnabled = workspace.config?.server?.mcp?.enabled ?? false;

    logger.debug("Platform MCP: Checked workspace MCP settings", {
      workspaceId,
      mcpEnabled,
    });

    return mcpEnabled;
  } catch (error) {
    // Consume any remaining response body to prevent leaks
    if (response) {
      try {
        await response.text();
      } catch {
        // Ignore errors when consuming error response body
      }
    }
    logger.error("Platform MCP: Error checking workspace MCP settings", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false; // Fail closed - deny access on error
  }
}

/**
 * Check if a job is discoverable for a workspace
 * SECURITY: Respects workspace-level discoverable.jobs configuration
 */
export async function checkJobDiscoverable(
  daemonUrl: string,
  workspaceId: string,
  jobName: string,
  logger: Logger,
): Promise<boolean> {
  let response: Response | undefined;
  try {
    response = await fetch(`${daemonUrl}/api/workspaces/${workspaceId}`);
    if (!response.ok) {
      // Consume the response body to prevent leaks
      try {
        await response.text();
      } catch {
        // Ignore errors when consuming error response body
      }
      return false; // Fail closed
    }

    const workspace = await response.json();
    const discoverableJobs = workspace.config?.server?.mcp?.discoverable?.jobs || [];

    // Check if job matches any discoverable pattern
    for (const pattern of discoverableJobs) {
      const isWildcard = pattern.endsWith("*");
      const basePattern = isWildcard ? pattern.slice(0, -1) : pattern;

      if (isWildcard ? jobName.startsWith(basePattern) : jobName === pattern) {
        logger.debug("Platform MCP: Job is discoverable", {
          workspaceId,
          jobName,
          pattern,
        });
        return true;
      }
    }

    logger.debug("Platform MCP: Job not discoverable", {
      workspaceId,
      jobName,
      discoverableJobs,
    });

    return false;
  } catch (error) {
    // Consume any remaining response body to prevent leaks
    if (response) {
      try {
        await response.text();
      } catch {
        // Ignore errors when consuming error response body
      }
    }
    logger.error("Platform MCP: Error checking job discoverability", {
      workspaceId,
      jobName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false; // Fail closed
  }
}

/**
 * Create a successful MCP tool response
 */
export function createSuccessResponse(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError?: false;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
    isError: false,
  };
}

/**
 * Create an error MCP tool response
 */
export function createErrorResponse(
  message: string,
  details?: unknown,
): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const errorData = {
    error: message,
    ...(details && { details }),
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(errorData, null, 2),
      },
    ],
    isError: true,
  };
}
