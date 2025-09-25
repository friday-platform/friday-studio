/** Shared utilities for MCP tools */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../platform-server.ts";

/** Build validated query params for library APIs */
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

  if (options.limit !== undefined && (options.limit < 1 || options.limit > 1000)) {
    throw new Error("Limit must be between 1 and 1000");
  }
  if (options.offset !== undefined && options.offset < 0) {
    throw new Error("Offset must be non-negative");
  }

  let sinceDate: Date | undefined;
  let untilDate: Date | undefined;

  if (options.since) {
    try {
      sinceDate = new Date(options.since);
      if (Number.isNaN(sinceDate.getTime())) {
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
      if (Number.isNaN(untilDate.getTime())) {
        throw new Error("Invalid until date format");
      }
    } catch {
      throw new Error(
        "Invalid until date format. Use ISO 8601 format (e.g., 2024-01-15T10:30:00Z)",
      );
    }
  }

  if (sinceDate && untilDate && sinceDate >= untilDate) {
    throw new Error("'since' date must be before 'until' date");
  }

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
    params.set("type", options.type.map((t) => t.toLowerCase()).join(","));
  }

  if (options.tags && options.tags.length > 0) {
    if (options.tags.length > 50) {
      throw new Error("Too many tag filters (max 50)");
    }
    params.set("tags", options.tags.map((t) => t.toLowerCase()).join(","));
  }

  if (sinceDate) {
    params.set("since", sinceDate.toISOString());
  }
  if (untilDate) {
    params.set("until", untilDate.toISOString());
  }

  if (options.limit !== undefined) {
    params.set("limit", Math.floor(options.limit).toString());
  }
  if (options.offset !== undefined) {
    params.set("offset", Math.floor(options.offset).toString());
  }

  return params;
}

/** Handle daemon API response with retry support */
export async function handleDaemonResponse(
  response: Response,
  operation: string,
  logger: Logger,
  options: { retryCount?: number; maxRetries?: number } = {},
): Promise<unknown> {
  const { retryCount = 0, maxRetries = 3 } = options;

  if (!response.ok) {
    let errorData: unknown = {};
    let responseText = "";

    try {
      const text = await response.text();
      responseText = text;
      if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
        errorData = JSON.parse(text);
      } else {
        errorData = { message: text };
      }
    } catch (parseError) {
      errorData = {
        message: responseText || response.statusText,
        parseError: parseError instanceof Error ? parseError.message : String(parseError),
      };
    }

    const isRetryable = isRetryableError(response.status);

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

    logger.error(`Daemon API error for ${operation}`, errorInfo);

    if (isRetryable && retryCount < maxRetries) {
      const delay = calculateRetryDelay(retryCount);
      logger.info(
        `Retrying ${operation} after ${delay}ms (attempt ${retryCount + 1}/${maxRetries})`,
      );

      await sleep(delay);

      const retryError = new Error(
        `Daemon API error for ${operation}: ${response.status} - ${
          errorData.error || errorData.message || response.statusText
        } (retry ${retryCount + 1}/${maxRetries})`,
      );

      retryError.code = -32000;

      retryError.details = errorInfo;

      retryError.shouldRetry = true;
      throw retryError;
    }

    const error = new Error(
      `Daemon API error for ${operation}: ${response.status} - ${
        errorData.error || errorData.message || response.statusText
      }${retryCount > 0 ? ` (failed after ${retryCount} retries)` : ""}`,
    );

    error.code = -32000;

    error.details = errorInfo;

    error.shouldRetry = false;
    throw error;
  }

  try {
    const result = await response.json();

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

    parseError.code = -32603;

    parseError.details = {
      operation,
      status: response.status,
      url: response.url,
      retryCount,
      originalError: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    };

    logger.error(`Parse error for ${operation}`, parseError.details);
    throw parseError;
  }
}

/** Fetch with configurable timeout */
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

      timeoutError.code = -32000;

      timeoutError.details = { url, timeoutMs, timestamp: new Date().toISOString() };
      throw timeoutError;
    }

    throw error;
  }
}

/** Check if HTTP status is retryable */
function isRetryableError(status: number): boolean {
  return (
    status >= 500 || // Server errors
    status === 408 || // Request timeout
    status === 429 || // Too many requests
    status === 503 || // Service unavailable
    status === 504 // Gateway timeout
  );
}

/** Calculate retry delay with exponential backoff */
function calculateRetryDelay(retryCount: number): number {
  const baseDelay = 2 ** retryCount * 1000;
  const jitter = Math.random() * 0.3 * baseDelay;
  return Math.min(baseDelay + jitter, 30000);
}

/** Sleep for specified milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if job is discoverable for workspace */
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
      try {
        await response.text();
      } catch {}
      return false;
    }

    const workspace = await response.json();
    const discoverableJobs = workspace.config?.server?.mcp?.discoverable?.jobs || [];

    for (const pattern of discoverableJobs) {
      const isWildcard = pattern.endsWith("*");
      const basePattern = isWildcard ? pattern.slice(0, -1) : pattern;

      if (isWildcard ? jobName.startsWith(basePattern) : jobName === pattern) {
        logger.debug("Platform MCP: Job is discoverable", { workspaceId, jobName, pattern });
        return true;
      }
    }

    logger.debug("Platform MCP: Job not discoverable", { workspaceId, jobName, discoverableJobs });

    return false;
  } catch (error) {
    if (response) {
      try {
        await response.text();
      } catch {}
    }
    logger.error("Platform MCP: Error checking job discoverability", {
      workspaceId,
      jobName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Create successful MCP response */
export function createSuccessResponse(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false };
}

/** Create error MCP response */
export function createErrorResponse(message: string, details?: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, details }) }],
    isError: true,
  };
}
