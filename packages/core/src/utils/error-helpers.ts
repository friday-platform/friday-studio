import { APICallError } from "@ai-sdk/provider";
import { stringifyError } from "@atlas/utils";
import { z } from "zod";
import {
  type APIErrorCause,
  type ErrorCause,
  ErrorCauseSchema,
  type NetworkErrorCause,
} from "../types/error-causes.ts";

/**
 * Zod schema for validating APICallError structure
 */
const APICallErrorSchema = z.object({
  message: z.string(),
  url: z.string(),
  requestBodyValues: z.unknown(),
  statusCode: z.number().optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  responseBody: z.string().optional(),
  isRetryable: z.boolean().optional(),
  data: z.unknown(),
});

/**
 * Provider error message patterns
 */
// Pattern 1: error.data.error.message (Anthropic/OpenAI)
const NestedErrorMessageSchema = z.object({ error: z.object({ message: z.string().min(1) }) });

// Pattern 2: error.data.message (simpler format)
const SimpleMessageSchema = z.object({ message: z.string().min(1) });

// Pattern 3: JSON responseBody with error.message
const ResponseBodyErrorSchema = z.object({ error: z.object({ message: z.string().min(1) }) });

// Pattern 4: JSON responseBody with message
const ResponseBodyMessageSchema = z.object({ message: z.string().min(1) });

/**
 * Throw an error with a structured, validated cause
 */
export function throwWithCause(message: string, cause: ErrorCause | Error | unknown): never {
  // If cause is already an Error, wrap it
  if (cause instanceof Error) {
    throw new Error(message, { cause });
  }

  // If cause is a string, wrap it in an Error
  if (typeof cause === "string") {
    throw new Error(message, { cause: new Error(cause) });
  }

  // Try to validate as structured cause
  const result = ErrorCauseSchema.safeParse(cause);
  if (result.success) {
    throw new Error(message, { cause: result.data });
  }

  // Fallback: wrap unknown cause in an Error
  throw new Error(message, { cause: new Error(String(cause)) });
}

/**
 * Parse and validate error cause from an error object
 *
 * @internal - Exported only for testing, not part of public API
 */
export function parseErrorCause(error: unknown): ErrorCause | undefined {
  if (!(error instanceof Error)) return undefined;

  const result = ErrorCauseSchema.safeParse(error.cause);
  return result.success ? result.data : undefined;
}

/**
 * Type guard to check if an error cause is an API error
 */
export function isAPIErrorCause(cause: ErrorCause): cause is APIErrorCause {
  return cause.type === "api";
}

/**
 * Type guard to check if an error cause is a network error
 */
export function isNetworkErrorCause(cause: ErrorCause): cause is NetworkErrorCause {
  return cause.type === "network";
}

/**
 * Parse and validate an error as APICallError
 * Returns actual APICallError instance or null
 * Handles module boundary issues by constructing new instance from validated data
 */
export function parseAPICallError(error: unknown): APICallError | null {
  // Fast path: if it's already an APICallError instance, return it
  if (APICallError.isInstance(error)) {
    return error;
  }

  // Otherwise, validate structure with Zod and construct new instance
  const result = APICallErrorSchema.safeParse(error);
  if (!result.success) {
    return null;
  }

  // Construct from validated data
  return new APICallError({
    message: result.data.message,
    url: result.data.url,
    requestBodyValues: result.data.requestBodyValues,
    statusCode: result.data.statusCode,
    responseHeaders: result.data.responseHeaders,
    responseBody: result.data.responseBody,
    isRetryable: result.data.isRetryable,
    data: result.data.data,
  });
}

/**
 * Create a structured, VALIDATED cause from various error types
 * Only classifies errors when we have concrete data (e.g., HTTP status codes)
 */
export function createErrorCause(error: unknown): ErrorCause {
  // Handle APICallError from @ai-sdk/provider - we have concrete status codes
  const apiError = parseAPICallError(error);
  if (apiError) {
    const cause = createAPIErrorCause(apiError);
    return ErrorCauseSchema.parse(cause);
  }

  // Check if error already has a structured cause
  if (error instanceof Error) {
    const existingCause = parseErrorCause(error);
    if (existingCause) {
      return existingCause; // Already validated
    }
  }

  // Everything else is unknown - don't guess from error messages
  const cause = {
    type: "unknown" as const,
    code: "UNKNOWN_ERROR",
    originalError: stringifyError(error),
  };

  // ALWAYS validate with Zod before returning
  return ErrorCauseSchema.parse(cause);
}

/**
 * Generate user-friendly display message from error cause
 * Single source of truth for error messages shown to users
 */
export function getErrorDisplayMessage(errorCause: ErrorCause): string {
  if (isAPIErrorCause(errorCause)) {
    const apiCause = errorCause;
    switch (apiCause.code) {
      case "RATE_LIMIT_ERROR":
        return apiCause.retryAfter
          ? `Rate limit exceeded. Please wait ${apiCause.retryAfter} seconds before retrying.`
          : "Rate limit exceeded. Please wait a moment before retrying.";
      case "AUTHENTICATION_ERROR":
        return apiCause.providerMessage
          ? `Authentication failed: ${apiCause.providerMessage}`
          : "Authentication failed. Please check your API key configuration.";
      case "PERMISSION_ERROR":
        return apiCause.providerMessage
          ? `Permission denied: ${apiCause.providerMessage}`
          : "Permission denied. Your API key may not have access to this resource.";
      case "SERVICE_UNAVAILABLE":
        return apiCause.isRetryable
          ? "Service temporarily unavailable. Retrying automatically..."
          : "Service temporarily unavailable. Please try again later.";
      case "OVERLOADED_ERROR":
        return "Service is currently overloaded. Request will be retried automatically.";
      case "DEADLINE_EXCEEDED":
        return "Request took too long to complete. Try simplifying your request.";
      default:
        return apiCause.providerMessage
          ? `API error (${apiCause.statusCode}): ${apiCause.providerMessage}`
          : `API error (${apiCause.statusCode}): ${apiCause.code}`;
    }
  } else if (isNetworkErrorCause(errorCause)) {
    return "Network connection failed. Please check your internet connection and try again.";
  } else {
    // For unknown errors, include the original error if available
    if (errorCause.type === "unknown" && errorCause.originalError) {
      return `Error: ${errorCause.originalError}`;
    }

    return "An unexpected error occurred. Please try again.";
  }
}

/**
 * Create API error cause from APICallError
 * Extracts all available concrete data from the error
 */
function createAPIErrorCause(error: APICallError): APIErrorCause {
  const statusCode = error.statusCode || 0;

  // Extract retry-after from response headers if available
  const retryAfter = error.responseHeaders?.["retry-after"]
    ? parseInt(error.responseHeaders["retry-after"], 10)
    : undefined;

  // Use all available data from APICallError
  const providerMessage = extractProviderMessage(error);

  const baseApiCause = {
    type: "api" as const,
    statusCode,
    url: error.url,
    isRetryable: error.isRetryable,
    retryAfter,
    providerMessage,
  };

  // Map status codes to error codes for easier handling
  // Covers Anthropic, OpenAI, and Google Gemini error patterns
  switch (statusCode) {
    case 400:
      return { ...baseApiCause, code: "INVALID_REQUEST" };
    case 401:
      return { ...baseApiCause, code: "AUTHENTICATION_ERROR" };
    case 403:
      return { ...baseApiCause, code: "PERMISSION_ERROR" };
    case 404:
      return { ...baseApiCause, code: "NOT_FOUND" };
    case 413:
      return { ...baseApiCause, code: "REQUEST_TOO_LARGE" };
    case 429:
      return { ...baseApiCause, code: "RATE_LIMIT_ERROR" };
    case 500:
      return { ...baseApiCause, code: "API_ERROR" };
    case 503:
      // Service temporarily unavailable or overloaded
      return { ...baseApiCause, code: "SERVICE_UNAVAILABLE" };
    case 504:
      // Gateway timeout - request took too long to process (Google Gemini)
      return { ...baseApiCause, code: "DEADLINE_EXCEEDED" };
    case 529:
      // Anthropic-specific overload code
      return { ...baseApiCause, code: "OVERLOADED_ERROR" };
    default:
      return { ...baseApiCause, code: `API_ERROR_${statusCode}` };
  }
}

function extractProviderMessage(error: APICallError): string | undefined {
  // Try nested error message: data.error.message (Anthropic/OpenAI)
  const nestedResult = NestedErrorMessageSchema.safeParse(error.data);
  if (nestedResult.success) {
    return nestedResult.data.error.message;
  }

  // Try simple message: data.message
  const simpleResult = SimpleMessageSchema.safeParse(error.data);
  if (simpleResult.success) {
    return simpleResult.data.message;
  }

  // Try parsing responseBody as JSON
  if (typeof error.responseBody === "string" && error.responseBody.length > 0) {
    try {
      const parsed = JSON.parse(error.responseBody);

      // Try nested error in response body
      const bodyErrorResult = ResponseBodyErrorSchema.safeParse(parsed);
      if (bodyErrorResult.success) {
        return bodyErrorResult.data.error.message;
      }

      // Try simple message in response body
      const bodyMessageResult = ResponseBodyMessageSchema.safeParse(parsed);
      if (bodyMessageResult.success) {
        return bodyMessageResult.data.message;
      }
    } catch {
      // Ignore JSON parse errors - response body might not be JSON
    }
  }

  return undefined;
}
