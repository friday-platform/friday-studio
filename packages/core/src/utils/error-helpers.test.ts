import { APICallError } from "@ai-sdk/provider";
import { assertEquals, assertThrows } from "@std/assert";
import {
  createErrorCause,
  getErrorDisplayMessage,
  parseErrorCause,
  throwWithCause,
} from "./error-helpers.ts";

Deno.test("createErrorCause - handles APICallError with status code", () => {
  const error = new APICallError({
    message: "Rate limit exceeded",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: { prompt: "test" },
    statusCode: 429,
    isRetryable: true,
    responseHeaders: { "retry-after": "60" },
  });

  const cause = createErrorCause(error);

  assertEquals(cause.type, "api");
  assertEquals(cause.code, "RATE_LIMIT_ERROR");
  if (cause.type === "api") {
    assertEquals(cause.statusCode, 429);
    assertEquals(cause.url, "https://api.example.com/v1/chat");
    assertEquals(cause.isRetryable, true);
    assertEquals(cause.retryAfter, 60);
  }
});

Deno.test("createErrorCause - captures provider message from payload", () => {
  const error = new APICallError({
    message: "Authentication error",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: { prompt: "test" },
    statusCode: 401,
    isRetryable: false,
    data: { error: { type: "authentication_error", message: "invalid x-api-key" } },
  });

  const cause = createErrorCause(error);

  assertEquals(cause.type, "api");
  assertEquals(cause.code, "AUTHENTICATION_ERROR");
  if (cause.type === "api") {
    assertEquals(cause.providerMessage, "invalid x-api-key");
  }
});

Deno.test("createErrorCause - handles 529 overload error", () => {
  const error = new APICallError({
    message: "API overloaded",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: { prompt: "test" },
    statusCode: 529,
    isRetryable: true,
  });

  const cause = createErrorCause(error);

  assertEquals(cause.type, "api");
  assertEquals(cause.code, "OVERLOADED_ERROR");
  if (cause.type === "api") {
    assertEquals(cause.statusCode, 529);
    assertEquals(cause.isRetryable, true);
  }
});

Deno.test("createErrorCause - handles 503 service unavailable error", () => {
  const error = new APICallError({
    message: "Service unavailable",
    url: "https://api.openai.com/v1/chat/completions",
    requestBodyValues: { model: "gpt-4", messages: [] },
    statusCode: 503,
    isRetryable: true,
  });

  const cause = createErrorCause(error);

  assertEquals(cause.type, "api");
  assertEquals(cause.code, "SERVICE_UNAVAILABLE");
  if (cause.type === "api") {
    assertEquals(cause.statusCode, 503);
    assertEquals(cause.isRetryable, true);
  }
});

Deno.test("createErrorCause - handles 504 deadline exceeded error", () => {
  const error = new APICallError({
    message: "Deadline exceeded",
    url: "https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent",
    requestBodyValues: { contents: [{ text: "long prompt" }] },
    statusCode: 504,
    isRetryable: false,
  });

  const cause = createErrorCause(error);

  assertEquals(cause.type, "api");
  assertEquals(cause.code, "DEADLINE_EXCEEDED");
  if (cause.type === "api") {
    assertEquals(cause.statusCode, 504);
    assertEquals(cause.isRetryable, false);
  }
});

Deno.test("createErrorCause - handles unknown errors", () => {
  const error = new Error("Something went wrong");
  const cause = createErrorCause(error);

  assertEquals(cause.type, "unknown");
  assertEquals(cause.code, "UNKNOWN_ERROR");
  if (cause.type === "unknown") {
    assertEquals(cause.originalError, "Something went wrong");
  }
});

Deno.test("parseErrorCause - parses valid error cause", () => {
  const error = new Error("Test error", {
    cause: { type: "api", code: "RATE_LIMIT_ERROR", statusCode: 429 },
  });

  const cause = parseErrorCause(error);

  assertEquals(cause?.type, "api");
  assertEquals(cause?.code, "RATE_LIMIT_ERROR");
});

Deno.test("parseErrorCause - returns undefined for invalid cause", () => {
  const error = new Error("Test error", { cause: "invalid cause" });

  const cause = parseErrorCause(error);

  assertEquals(cause, undefined);
});

Deno.test("throwWithCause - throws error with validated cause", () => {
  assertThrows(
    () => {
      throwWithCause("Test error", { type: "api", code: "TEST_ERROR", statusCode: 500 });
    },
    Error,
    "Test error",
  );
});

Deno.test("throwWithCause - wraps Error as cause", () => {
  const originalError = new Error("Original error");

  assertThrows(
    () => {
      throwWithCause("Wrapped error", originalError);
    },
    Error,
    "Wrapped error",
  );
});

Deno.test("getErrorDisplayMessage - handles rate limit errors", () => {
  const errorCause = {
    type: "api" as const,
    code: "RATE_LIMIT_ERROR",
    statusCode: 429,
    retryAfter: 60,
  };

  const message = getErrorDisplayMessage(errorCause);
  assertEquals(message, "Rate limit exceeded. Please wait 60 seconds before retrying.");
});

Deno.test("getErrorDisplayMessage - includes provider message for auth errors", () => {
  const errorCause = {
    type: "api" as const,
    code: "AUTHENTICATION_ERROR",
    statusCode: 401,
    providerMessage: "invalid x-api-key",
  };

  const message = getErrorDisplayMessage(errorCause);
  assertEquals(message, "Authentication failed: invalid x-api-key");
});

Deno.test("getErrorDisplayMessage - handles network errors", () => {
  const errorCause = { type: "network" as const, code: "NETWORK_ERROR" };

  const message = getErrorDisplayMessage(errorCause);
  assertEquals(
    message,
    "Network connection failed. Please check your internet connection and try again.",
  );
});

Deno.test("getErrorDisplayMessage - handles unknown errors", () => {
  const errorCause = { type: "unknown" as const, code: "UNKNOWN_ERROR" };

  const message = getErrorDisplayMessage(errorCause);
  assertEquals(message, "An unexpected error occurred. Please try again.");
});
