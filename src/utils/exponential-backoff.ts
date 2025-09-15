/**
 * Exponential backoff utility for retrying operations with configurable delays
 */

interface ExponentialBackoffOptions {
  /**
   * Maximum number of retry attempts (default: 10)
   */
  maxRetries?: number;

  /**
   * Initial delay in milliseconds (default: 1000ms)
   */
  initialDelay?: number;

  /**
   * Maximum delay in milliseconds (default: 30000ms)
   */
  maxDelay?: number;

  /**
   * Multiplier for exponential backoff (default: 2)
   */
  multiplier?: number;

  /**
   * Optional callback for each retry attempt
   */
  onRetry?: (attempt: number, delay: number, error: unknown) => void | Promise<void>;

  /**
   * Function to determine if an error is retryable (default: checks for overload errors)
   */
  isRetryable?: (error: unknown) => boolean;
}

/**
 * Default function to check if an error is an overload error
 */
export function isOverloadError(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorObj = error;

  return errorMessage.toLowerCase().includes("overload") || errorObj?.type === "overloaded_error";
}

/**
 * Check if an error is a rate limit error (429)
 */
export function isRateLimitError(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorObj = error;

  return (
    errorObj?.type === "rate_limit_error" ||
    errorObj?.status === 429 ||
    errorMessage.toLowerCase().includes("rate limit") ||
    errorMessage.toLowerCase().includes("429")
  );
}

/**
 * Check if an error is a transient error that should be retried
 * This includes overload errors, rate limits, and server errors
 */
export function isTransientError(error: unknown): boolean {
  const errorObj = error;

  // Check for specific error types
  if (isOverloadError(error) || isRateLimitError(error)) {
    return true;
  }

  // Check for server errors (500-503)
  if (errorObj?.status && errorObj.status >= 500 && errorObj.status <= 503) {
    return true;
  }

  // Check for API errors
  if (errorObj?.type === "api_error") {
    return true;
  }

  return false;
}

/**
 * Calculate exponential backoff delay
 */
export function calculateBackoffDelay(
  attempt: number,
  options: Pick<ExponentialBackoffOptions, "initialDelay" | "maxDelay" | "multiplier"> = {},
): number {
  const { initialDelay = 1000, maxDelay = 30000, multiplier = 2 } = options;

  if (attempt <= 0) return 0;

  const delay = initialDelay * multiplier ** (attempt - 1);
  return Math.min(delay, maxDelay);
}

/**
 * Execute a function with exponential backoff retry logic
 *
 * @param fn - The async function to execute
 * @param options - Configuration options for retry behavior
 * @returns The result of the function if successful
 * @throws The last error if all retries are exhausted
 *
 * @example
 * ```typescript
 * const result = await withExponentialBackoff(
 *   async () => {
 *     return await makeApiCall();
 *   },
 *   {
 *     maxRetries: 5,
 *     onRetry: (attempt, delay) => {
 *       console.log(`Retrying attempt ${attempt} after ${delay}ms`);
 *     },
 *     isRetryable: (error) => {
 *       return error.code === 'RATE_LIMITED';
 *     }
 *   }
 * );
 * ```
 */
export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  options: ExponentialBackoffOptions = {},
): Promise<T> {
  const {
    maxRetries = 10,
    initialDelay = 1000,
    maxDelay = 30000,
    multiplier = 2,
    onRetry,
    isRetryable = isOverloadError,
  } = options;

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Calculate delay for this attempt
      const delay =
        attempt > 0 ? calculateBackoffDelay(attempt, { initialDelay, maxDelay, multiplier }) : 0;

      // Wait if this is a retry
      if (delay > 0) {
        if (onRetry) {
          await onRetry(attempt, delay, lastError);
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      // Try to execute the function
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (!isRetryable(error) || attempt >= maxRetries) {
        throw error;
      }

      // Continue to next retry attempt
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError || new Error("Unexpected error in retry loop");
}

/**
 * Create a retry wrapper with preset options
 *
 * @example
 * ```typescript
 * const retryWithOverloadHandling = createRetryWrapper({
 *   maxRetries: 5,
 *   isRetryable: isOverloadError
 * });
 *
 * const result = await retryWithOverloadHandling(async () => {
 *   return await apiClient.makeRequest();
 * });
 * ```
 */
export function createRetryWrapper(defaultOptions: ExponentialBackoffOptions) {
  return <T>(fn: () => Promise<T>, overrideOptions?: ExponentialBackoffOptions): Promise<T> => {
    return withExponentialBackoff(fn, { ...defaultOptions, ...overrideOptions });
  };
}
