# Exponential Backoff Usage Examples

## Current Implementation (Overload-specific)

The current implementation in ConversationAgent specifically handles overload errors:

```typescript
import { isOverloadError, withExponentialBackoff } from "../../../src/utils/exponential-backoff.ts";

// In ConversationAgent.execute()
const result = await withExponentialBackoff(
  async () => {
    // ... streamText logic ...
  },
  {
    maxRetries: 10,
    isRetryable: isOverloadError, // Only retries overload errors
  },
);
```

## Alternative: Handle All Transient Errors

To handle a broader range of transient errors (rate limits, server errors, etc.):

```typescript
import {
  isTransientError,
  withExponentialBackoff,
} from "../../../src/utils/exponential-backoff.ts";

// In ConversationAgent.execute()
const result = await withExponentialBackoff(
  async () => {
    // ... streamText logic ...
  },
  {
    maxRetries: 10,
    isRetryable: isTransientError, // Retries all transient errors
  },
);
```

## Custom Error Handling

For specific error handling requirements:

```typescript
import {
  isOverloadError,
  isRateLimitError,
  withExponentialBackoff,
} from "../../../src/utils/exponential-backoff.ts";

// Custom retry logic
const result = await withExponentialBackoff(
  async () => {
    // ... streamText logic ...
  },
  {
    maxRetries: 10,
    isRetryable: (error) => {
      // Custom logic: retry overload errors and rate limits, but not other errors
      return isOverloadError(error) || isRateLimitError(error);
    },
    onRetry: async (attempt, delay, error) => {
      if (isRateLimitError(error)) {
        // Special handling for rate limits
        console.log(`Rate limited. Waiting ${delay}ms before retry ${attempt}`);
      }
    },
  },
);
```

## Error-Specific Retry Strategies

Different retry strategies based on error type:

```typescript
const result = await withExponentialBackoff(
  async () => {
    // ... streamText logic ...
  },
  {
    maxRetries: (error) => {
      if (isRateLimitError(error)) return 5; // Fewer retries for rate limits
      if (isOverloadError(error)) return 10; // More retries for overload
      return 3; // Default for other transient errors
    },
    initialDelay: (error) => {
      // Rate limits might have a retry-after header
      const retryAfter = error?.retryAfter;
      if (retryAfter) return retryAfter * 1000;
      return 1000; // Default 1 second
    },
    isRetryable: isTransientError,
  },
);
```
