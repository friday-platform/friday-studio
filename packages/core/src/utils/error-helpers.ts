import { stringifyError } from "@atlas/utils";
import { APICallError, RetryError } from "ai";
import { z } from "zod";
import {
  type APIErrorCause,
  type ErrorCause,
  ErrorCauseSchema,
  type NetworkErrorCause,
} from "../types/error-causes.ts";

/**
 * Zod schema for validating AI SDK API Call errors
 * @see https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error
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
 * Zod schema for parsing AI SDK Retry errors
 * Only message, reason, and errors are set by the constructor
 * @see https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-retry-error
 */
const AiRetryErrorSchema = z.object({
  reason: z
    .union([z.literal("maxRetriesExceeded"), z.literal("errorNotRetryable"), z.literal("abort")])
    .optional(),
  message: z.string(),
  lastError: z.unknown().optional(),
  requestBodyValues: z.unknown().optional(),
  errors: z.unknown().array(),
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

function parseAiRetryError(error: unknown): RetryError | null {
  if (RetryError.isInstance(error)) {
    return error;
  }

  // Otherwise, validate structure with Zod and construct new instance
  const result = AiRetryErrorSchema.safeParse(error);
  if (!result.success) {
    return null;
  }

  // Construct from validated data
  // Default to maxRetriesExceeded if reason is missing (e.g., from serialization)
  return new RetryError({
    message: result.data.message,
    errors: result.data.errors,
    reason: result.data.reason ?? "maxRetriesExceeded",
  });
}

/**
 * Try to create an API error cause from a value
 * Returns validated ErrorCause if value is an APICallError, null otherwise
 */
function getCauseFromAiApiCallError(value: unknown): ErrorCause | null {
  const apiError = parseAPICallError(value);
  if (!apiError) return null;
  return ErrorCauseSchema.parse(createAPIErrorCause(apiError));
}

/**
 * Detect if an error is a network/connection error
 * Returns NetworkErrorCause if detected, null otherwise
 *
 * Note: Fetch/HTTP errors in Deno/browsers are TypeErrors without standard error codes.
 * We classify based on error type first, then use minimal keywords only to distinguish
 * subtypes (timeout vs connection vs certificate). This is the most reliable approach
 * available without standard error codes.
 */
function tryCreateNetworkErrorCause(error: unknown): ErrorCause | null {
  // Network errors from fetch are TypeErrors
  if (!(error instanceof TypeError)) return null;

  const errorMessage = error.message.toLowerCase();

  // Minimal keyword checks to distinguish error subtypes
  // These are standard error categories, not arbitrary string matching
  const isCertificateError = errorMessage.includes("certificate") || errorMessage.includes("tls");
  const isTimeout = errorMessage.includes("timeout");
  const isConnectionError = errorMessage.includes("connection") || errorMessage.includes("connect");

  // If it's a TypeError but doesn't match network patterns, it's not a network error
  if (!isCertificateError && !isTimeout && !isConnectionError) return null;

  let code: string;
  if (isCertificateError) {
    code = "NETWORK_CERTIFICATE_ERROR";
  } else if (isTimeout) {
    code = "NETWORK_TIMEOUT";
  } else {
    code = "NETWORK_CONNECTION_FAILED";
  }

  const cause: NetworkErrorCause = { type: "network" as const, code };

  return ErrorCauseSchema.parse(cause);
}

/**
 * Create a structured, VALIDATED cause from various error types
 * Only classifies errors when we have concrete data (e.g., HTTP status codes)
 */
export function createErrorCause(error: unknown): ErrorCause {
  // Handle APICallError from @ai-sdk/provider - we have concrete status codes
  let cause = getCauseFromAiApiCallError(error);
  if (cause) return cause;

  // Check against retry errors from the AI SDK
  const retryError = parseAiRetryError(error);
  if (retryError) {
    // AI SDK's RetryError.lastError is declared but never populated by constructor
    // The actual errors are stored in the errors array
    if (retryError.lastError) {
      cause = getCauseFromAiApiCallError(retryError.lastError);
      if (cause) return cause;
    }

    // Check errors array as that's where AI SDK actually stores errors
    if (retryError.errors && retryError.errors.length > 0) {
      cause = getCauseFromAiApiCallError(retryError.errors[0]);
      if (cause) return cause;
    }
  }

  // Check if error already has a structured cause (Error instances only)
  if (error instanceof Error) {
    const existingCause = parseErrorCause(error);
    if (existingCause) return existingCause;

    // Check if the error cause contains an APICallError (other retry patterns)
    if (error.cause) {
      cause = getCauseFromAiApiCallError(error.cause);
      if (cause) return cause;
    }
  }

  // Check for network/connection errors (TypeError with specific patterns)
  cause = tryCreateNetworkErrorCause(error);
  if (cause) return cause;

  // Everything else is unknown - don't guess from error messages
  return ErrorCauseSchema.parse({
    type: "unknown" as const,
    code: "UNKNOWN_ERROR",
    originalError: stringifyError(error),
  });
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
        return apiCause.providerMessage
          ? `API response: ${apiCause.providerMessage}`
          : "Service is currently overloaded.";
      case "DEADLINE_EXCEEDED":
        return "Request took too long to complete. Try simplifying your request.";
      default:
        return apiCause.providerMessage
          ? `API error (${apiCause.statusCode}): ${apiCause.providerMessage}`
          : `API error (${apiCause.statusCode}): ${apiCause.code}`;
    }
  } else if (isNetworkErrorCause(errorCause)) {
    const networkCause = errorCause;

    // Certificate/TLS errors
    if (networkCause.code === "NETWORK_CERTIFICATE_ERROR") {
      return "Security certificate verification failed. This may be a proxy or network configuration issue.";
    }

    // Timeout errors
    if (networkCause.code === "NETWORK_TIMEOUT") {
      return "Request timed out. The service may be overloaded or unreachable.";
    }

    // Connection failures
    return "Network connection failed. Please check your internet connection and try again.";
  } else {
    // For unknown errors, include the original error if available
    if (errorCause.type === "unknown" && errorCause.originalError) {
      return errorCause.originalError;
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
