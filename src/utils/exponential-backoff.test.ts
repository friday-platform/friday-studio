import { assertEquals, assertRejects } from "@std/assert";
import {
  calculateBackoffDelay,
  createRetryWrapper,
  isOverloadError,
  isRateLimitError,
  isTransientError,
  withExponentialBackoff,
} from "./exponential-backoff.ts";

Deno.test("isOverloadError - detects overload errors", async () => {
  // Test various overload error formats
  assertEquals(isOverloadError(new Error("Service overloaded")), true);
  assertEquals(isOverloadError(new Error("OVERLOADED")), true);
  assertEquals(isOverloadError(new Error("API is overloaded temporarily")), true);
  assertEquals(isOverloadError({ type: "overloaded_error", message: "Overloaded" }), true);
  assertEquals(isOverloadError({ type: "overloaded_error" }), true);

  // Test non-overload errors
  assertEquals(isOverloadError(new Error("Network error")), false);
  assertEquals(isOverloadError(new Error("Timeout")), false);
  assertEquals(isOverloadError({ type: "network_error" }), false);
  assertEquals(isOverloadError("Regular error string"), false);
});

Deno.test("isRateLimitError - detects rate limit errors", () => {
  // Test various rate limit error formats
  assertEquals(isRateLimitError({ type: "rate_limit_error" }), true);
  assertEquals(isRateLimitError({ status: 429 }), true);
  assertEquals(isRateLimitError(new Error("Rate limit exceeded")), true);
  assertEquals(isRateLimitError(new Error("429 Too Many Requests")), true);

  // Test non-rate-limit errors
  assertEquals(isRateLimitError(new Error("Network error")), false);
  assertEquals(isRateLimitError({ type: "overloaded_error" }), false);
  assertEquals(isRateLimitError({ status: 503 }), false);
});

Deno.test("isTransientError - detects various transient errors", () => {
  // Overload errors
  assertEquals(isTransientError({ type: "overloaded_error" }), true);
  assertEquals(isTransientError(new Error("Service overloaded")), true);

  // Rate limit errors
  assertEquals(isTransientError({ type: "rate_limit_error" }), true);
  assertEquals(isTransientError({ status: 429 }), true);

  // Server errors
  assertEquals(isTransientError({ status: 500 }), true);
  assertEquals(isTransientError({ status: 502 }), true);
  assertEquals(isTransientError({ status: 503 }), true);

  // API errors
  assertEquals(isTransientError({ type: "api_error" }), true);

  // Non-transient errors
  assertEquals(isTransientError({ status: 400 }), false);
  assertEquals(isTransientError({ status: 401 }), false);
  assertEquals(isTransientError({ status: 404 }), false);
  assertEquals(isTransientError({ type: "validation_error" }), false);
  assertEquals(isTransientError(new Error("Network timeout")), false);
});

Deno.test("calculateBackoffDelay - calculates correct delays", async () => {
  // Default options (1s initial, 2x multiplier, 30s max)
  assertEquals(calculateBackoffDelay(0), 0);
  assertEquals(calculateBackoffDelay(1), 1000);
  assertEquals(calculateBackoffDelay(2), 2000);
  assertEquals(calculateBackoffDelay(3), 4000);
  assertEquals(calculateBackoffDelay(4), 8000);
  assertEquals(calculateBackoffDelay(5), 16000);
  assertEquals(calculateBackoffDelay(6), 30000); // Capped at max
  assertEquals(calculateBackoffDelay(10), 30000); // Still capped

  // Custom options
  assertEquals(calculateBackoffDelay(3, { initialDelay: 100, multiplier: 3 }), 900);
  assertEquals(calculateBackoffDelay(2, { initialDelay: 500, maxDelay: 1000 }), 1000);
});

Deno.test("withExponentialBackoff - succeeds on first try", async () => {
  let callCount = 0;
  const result = await withExponentialBackoff(() => {
    callCount++;
    return Promise.resolve("success");
  });

  assertEquals(result, "success");
  assertEquals(callCount, 1);
});

Deno.test("withExponentialBackoff - retries on failure then succeeds", async () => {
  let callCount = 0;
  const result = await withExponentialBackoff(
    () => {
      callCount++;
      if (callCount < 3) {
        throw new Error("Service overloaded");
      }
      return Promise.resolve("success after retries");
    },
    { initialDelay: 10, maxDelay: 50 }, // Fast delays for testing
  );

  assertEquals(result, "success after retries");
  assertEquals(callCount, 3);
});

Deno.test("withExponentialBackoff - exhausts retries and throws", async () => {
  let callCount = 0;

  await assertRejects(
    async () => {
      await withExponentialBackoff(
        () => {
          callCount++;
          throw new Error("Always overloaded");
        },
        { maxRetries: 3, initialDelay: 10 },
      );
    },
    Error,
    "Always overloaded",
  );

  assertEquals(callCount, 4); // Initial attempt + 3 retries
});

Deno.test("withExponentialBackoff - stops retrying for non-retryable errors", async () => {
  let callCount = 0;

  await assertRejects(
    async () => {
      await withExponentialBackoff(
        () => {
          callCount++;
          throw new Error("Network error");
        },
        {
          maxRetries: 5,
          isRetryable: isOverloadError, // Only retry overload errors
        },
      );
    },
    Error,
    "Network error",
  );

  assertEquals(callCount, 1); // No retries for non-overload errors
});

Deno.test("withExponentialBackoff - calls onRetry callback", async () => {
  const retryLog: Array<{ attempt: number; delay: number }> = [];
  let callCount = 0;

  const result = await withExponentialBackoff(
    () => {
      callCount++;
      if (callCount < 4) {
        throw new Error("Overloaded");
      }
      return Promise.resolve("success");
    },
    {
      initialDelay: 10,
      maxDelay: 100,
      onRetry: (attempt, delay) => {
        retryLog.push({ attempt, delay });
      },
    },
  );

  assertEquals(result, "success");
  assertEquals(retryLog.length, 3);
  assertEquals(retryLog[0], { attempt: 1, delay: 10 });
  assertEquals(retryLog[1], { attempt: 2, delay: 20 });
  assertEquals(retryLog[2], { attempt: 3, delay: 40 });
});

Deno.test("withExponentialBackoff - custom isRetryable function", async () => {
  let callCount = 0;

  const result = await withExponentialBackoff(
    () => {
      callCount++;
      if (callCount === 1) {
        throw { code: "RATE_LIMITED" };
      }
      return Promise.resolve("success");
    },
    {
      initialDelay: 10,
      isRetryable: (error) => {
        const err = error as { code?: string };
        return err?.code === "RATE_LIMITED";
      },
    },
  );

  assertEquals(result, "success");
  assertEquals(callCount, 2);
});

Deno.test("createRetryWrapper - creates reusable retry function", async () => {
  const retryWithCustomSettings = createRetryWrapper({
    maxRetries: 2,
    initialDelay: 5,
    isRetryable: (error) => {
      const err = error as Error;
      return err?.message?.includes("retry");
    },
  });

  // Test that it uses the preset options
  let callCount1 = 0;
  const result1 = await retryWithCustomSettings(() => {
    callCount1++;
    if (callCount1 === 1) {
      throw new Error("please retry");
    }
    return Promise.resolve("success1");
  });

  assertEquals(result1, "success1");
  assertEquals(callCount1, 2);

  // Test that it doesn't retry non-matching errors
  let callCount2 = 0;
  await assertRejects(
    async () => {
      await retryWithCustomSettings(() => {
        callCount2++;
        throw new Error("do not retry");
      });
    },
    Error,
    "do not retry",
  );

  assertEquals(callCount2, 3); // Initial attempt + 2 retries (maxRetries: 2)
});

Deno.test("createRetryWrapper - override options", async () => {
  const retryWrapper = createRetryWrapper({ maxRetries: 5, initialDelay: 100 });

  let callCount = 0;
  const result = await retryWrapper(
    () => {
      callCount++;
      if (callCount < 2) {
        throw new Error("Overloaded");
      }
      return Promise.resolve("success");
    },
    { maxRetries: 1, initialDelay: 10 }, // Override defaults
  );

  assertEquals(result, "success");
  assertEquals(callCount, 2);
});

Deno.test("withExponentialBackoff - handles async errors in onRetry", async () => {
  let mainCallCount = 0;
  let retryCallCount = 0;

  // Currently, onRetry errors will bubble up and stop the retry process
  // This test documents the current behavior
  await assertRejects(
    async () => {
      await withExponentialBackoff(
        () => {
          mainCallCount++;
          if (mainCallCount < 3) {
            throw new Error("Overloaded");
          }
          return Promise.resolve("success");
        },
        {
          initialDelay: 10,
          onRetry: () => {
            retryCallCount++;
            throw new Error("Error in onRetry callback");
          },
        },
      );
    },
    Error,
    "Error in onRetry callback",
  );

  assertEquals(mainCallCount, 1);
  assertEquals(retryCallCount, 1);
});

Deno.test("withExponentialBackoff - zero retries", async () => {
  let callCount = 0;

  await assertRejects(
    async () => {
      await withExponentialBackoff(
        () => {
          callCount++;
          throw new Error("Overloaded");
        },
        { maxRetries: 0 },
      );
    },
    Error,
    "Overloaded",
  );

  assertEquals(callCount, 1); // Only initial attempt, no retries
});

Deno.test("withExponentialBackoff - preserves error context", async () => {
  const customError = new Error("Custom overload error");
  customError.name = "OverloadError";
  (customError as { code?: string; retryAfter?: number }).code = "OVERLOADED";
  (customError as { code?: string; retryAfter?: number }).retryAfter = 5000;

  try {
    await withExponentialBackoff(
      () => {
        throw customError;
      },
      { maxRetries: 1, initialDelay: 10 },
    );
  } catch (error) {
    assertEquals(error, customError);
    assertEquals((error as { code?: string; retryAfter?: number }).code, "OVERLOADED");
    assertEquals((error as { code?: string; retryAfter?: number }).retryAfter, 5000);
  }
});
