import { APICallError } from "@ai-sdk/provider";
import { expect, it } from "vitest";
import {
  createErrorCause,
  getErrorDisplayMessage,
  parseErrorCause,
  throwWithCause,
} from "./error-helpers.ts";

it("createErrorCause - handles APICallError with status code", () => {
  const error = new APICallError({
    message: "Rate limit exceeded",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: { prompt: "test" },
    statusCode: 429,
    isRetryable: true,
    responseHeaders: { "retry-after": "60" },
  });

  const cause = createErrorCause(error);

  expect(cause.type).toEqual("api");
  expect(cause.code).toEqual("RATE_LIMIT_ERROR");
  if (cause.type === "api") {
    expect(cause.statusCode).toEqual(429);
    expect(cause.url).toEqual("https://api.example.com/v1/chat");
    expect(cause.isRetryable).toEqual(true);
    expect(cause.retryAfter).toEqual(60);
  }
});

it("createErrorCause - captures provider message from payload", () => {
  const error = new APICallError({
    message: "Authentication error",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: { prompt: "test" },
    statusCode: 401,
    isRetryable: false,
    data: { error: { type: "authentication_error", message: "invalid x-api-key" } },
  });

  const cause = createErrorCause(error);

  expect(cause.type).toEqual("api");
  expect(cause.code).toEqual("AUTHENTICATION_ERROR");
  if (cause.type === "api") {
    expect(cause.providerMessage).toEqual("invalid x-api-key");
  }
});

it("createErrorCause - handles 529 overload error", () => {
  const error = new APICallError({
    message: "API overloaded",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: { prompt: "test" },
    statusCode: 529,
    isRetryable: true,
  });

  const cause = createErrorCause(error);

  expect(cause.type).toEqual("api");
  expect(cause.code).toEqual("OVERLOADED_ERROR");
  if (cause.type === "api") {
    expect(cause.statusCode).toEqual(529);
    expect(cause.isRetryable).toEqual(true);
  }
});

it("createErrorCause - handles 503 service unavailable error", () => {
  const error = new APICallError({
    message: "Service unavailable",
    url: "https://api.openai.com/v1/chat/completions",
    requestBodyValues: { model: "gpt-4", messages: [] },
    statusCode: 503,
    isRetryable: true,
  });

  const cause = createErrorCause(error);

  expect(cause.type).toEqual("api");
  expect(cause.code).toEqual("SERVICE_UNAVAILABLE");
  if (cause.type === "api") {
    expect(cause.statusCode).toEqual(503);
    expect(cause.isRetryable).toEqual(true);
  }
});

it("createErrorCause - handles 504 deadline exceeded error", () => {
  const error = new APICallError({
    message: "Deadline exceeded",
    url: "https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent",
    requestBodyValues: { contents: [{ text: "long prompt" }] },
    statusCode: 504,
    isRetryable: false,
  });

  const cause = createErrorCause(error);

  expect(cause.type).toEqual("api");
  expect(cause.code).toEqual("DEADLINE_EXCEEDED");
  if (cause.type === "api") {
    expect(cause.statusCode).toEqual(504);
    expect(cause.isRetryable).toEqual(false);
  }
});

it("createErrorCause - handles unknown errors", () => {
  const error = new Error("Something went wrong");
  const cause = createErrorCause(error);

  expect(cause.type).toEqual("unknown");
  expect(cause.code).toEqual("UNKNOWN_ERROR");
  if (cause.type === "unknown") {
    expect(cause.originalError).toEqual("Something went wrong");
  }
});

it("parseErrorCause - parses valid error cause", () => {
  const error = new Error("Test error", {
    cause: { type: "api", code: "RATE_LIMIT_ERROR", statusCode: 429 },
  });

  const cause = parseErrorCause(error);

  expect(cause?.type).toEqual("api");
  expect(cause?.code).toEqual("RATE_LIMIT_ERROR");
});

it("parseErrorCause - returns undefined for invalid cause", () => {
  const error = new Error("Test error", { cause: "invalid cause" });

  const cause = parseErrorCause(error);

  expect(cause).toBeUndefined();
});

it("throwWithCause - throws error with validated cause", () => {
  expect(() => {
    throwWithCause("Test error", { type: "api", code: "TEST_ERROR", statusCode: 500 });
  }).toThrow("Test error");
});

it("throwWithCause - wraps Error as cause", () => {
  const originalError = new Error("Original error");

  expect(() => {
    throwWithCause("Wrapped error", originalError);
  }).toThrow("Wrapped error");
});

it("getErrorDisplayMessage - handles rate limit errors", () => {
  const errorCause = {
    type: "api" as const,
    code: "RATE_LIMIT_ERROR",
    statusCode: 429,
    retryAfter: 60,
  };

  const message = getErrorDisplayMessage(errorCause);
  expect(message).toEqual("Rate limit exceeded. Please wait 60 seconds before retrying.");
});

it("getErrorDisplayMessage - includes provider message for auth errors", () => {
  const errorCause = {
    type: "api" as const,
    code: "AUTHENTICATION_ERROR",
    statusCode: 401,
    providerMessage: "invalid x-api-key",
  };

  const message = getErrorDisplayMessage(errorCause);
  expect(message).toEqual("Authentication failed: invalid x-api-key");
});

it("getErrorDisplayMessage - handles network errors", () => {
  const errorCause = { type: "network" as const, code: "NETWORK_ERROR" };

  const message = getErrorDisplayMessage(errorCause);
  expect(message).toEqual(
    "Network connection failed. Please check your internet connection and try again.",
  );
});

it("getErrorDisplayMessage - handles unknown errors", () => {
  const errorCause = { type: "unknown" as const, code: "UNKNOWN_ERROR" };

  const message = getErrorDisplayMessage(errorCause);
  expect(message).toEqual("An unexpected error occurred. Please try again.");
});

it("createErrorCause - unwraps APICallError from .errors array (AI SDK RetryError)", () => {
  // Simulate AI SDK's RetryError structure
  const retryError = {
    name: "RetryError",
    message: "Failed after 2 attempts",
    errors: [
      new APICallError({
        message: "Overloaded",
        url: "https://api.example.com/v1/messages",
        requestBodyValues: { prompt: "test" },
        statusCode: 529,
        isRetryable: true,
      }),
    ],
  };

  const cause = createErrorCause(retryError);

  expect(cause.type).toEqual("api");
  expect(cause.code).toEqual("OVERLOADED_ERROR");
  if (cause.type === "api") {
    expect(cause.statusCode).toEqual(529);
    expect(cause.isRetryable).toEqual(true);
  }
});

it("createErrorCause - unwraps APICallError from .cause (Deno std/async retry)", () => {
  // Simulate @std/async RetryError structure
  const apiCallError = new APICallError({
    message: "Authentication failed",
    url: "https://api.example.com/v1/chat",
    requestBodyValues: { model: "test" },
    statusCode: 401,
    isRetryable: false,
    data: { error: { message: "invalid api key" } },
  });

  const retryError = new Error("Operation failed after 5 attempts", { cause: apiCallError });

  const cause = createErrorCause(retryError);

  expect(cause.type).toEqual("api");
  expect(cause.code).toEqual("AUTHENTICATION_ERROR");
  if (cause.type === "api") {
    expect(cause.statusCode).toEqual(401);
    expect(cause.providerMessage).toEqual("invalid api key");
  }
});

it("createErrorCause - handles LiteLLM budget exceeded error", () => {
  // LiteLLM returns 400 Bad Request with budget_exceeded type in response body
  const error = new APICallError({
    message: "Bad Request",
    url: "http://litellm-proxy.atlas-operator.svc.cluster.local:4000/v1/messages",
    requestBodyValues: { model: "claude-sonnet-4-6", messages: [] },
    statusCode: 400,
    isRetryable: false,
    responseBody: JSON.stringify({
      error: {
        message: "Budget has been exceeded! Current cost: 200.09933819999978, Max budget: 200.0",
        type: "budget_exceeded",
        param: null,
        code: "400",
      },
    }),
  });

  const cause = createErrorCause(error);

  expect(cause.type).toEqual("api");
  expect(cause.code).toEqual("BUDGET_EXCEEDED");
  if (cause.type === "api") {
    expect(cause.statusCode).toEqual(400);
    expect(cause.isRetryable).toEqual(false);
    // Provider message should be extracted from the response body
    expect(cause.providerMessage).toEqual(
      "Budget has been exceeded! Current cost: 200.09933819999978, Max budget: 200.0",
    );
  }
});

it("createErrorCause - regular 400 error is not misclassified as budget exceeded", () => {
  // A regular 400 error should remain INVALID_REQUEST
  const error = new APICallError({
    message: "Bad Request",
    url: "https://api.example.com/v1/messages",
    requestBodyValues: { model: "test" },
    statusCode: 400,
    isRetryable: false,
    responseBody: JSON.stringify({
      error: { message: "Invalid parameter: model", type: "invalid_request_error" },
    }),
  });

  const cause = createErrorCause(error);

  expect(cause.type).toEqual("api");
  expect(cause.code).toEqual("INVALID_REQUEST");
});

it("getErrorDisplayMessage - handles budget exceeded error", () => {
  const errorCause = {
    type: "api" as const,
    code: "BUDGET_EXCEEDED",
    statusCode: 400,
    isRetryable: false,
  };

  const message = getErrorDisplayMessage(errorCause);
  expect(message).toEqual(
    "Your spending limit has been reached. Please contact support to increase your budget.",
  );
});
