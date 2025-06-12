/**
 * Test Utilities
 * Common utilities for integration and unit tests
 */

/**
 * Finds an available port by trying random ports in a range
 * @param minPort Minimum port number (default: 8000)
 * @param maxPort Maximum port number (default: 9999)
 * @param maxAttempts Maximum number of attempts (default: 10)
 * @returns Promise<number> Available port number
 * @throws Error if no available port found after maxAttempts
 */
export async function findAvailablePort(
  minPort = 8000,
  maxPort = 9999,
  maxAttempts = 10,
): Promise<number> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Generate random port in range
    const port = Math.floor(Math.random() * (maxPort - minPort + 1)) + minPort;

    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(
    `Failed to find available port in range ${minPort}-${maxPort} after ${maxAttempts} attempts`,
  );
}

/**
 * Checks if a port is available by attempting to bind to it
 * @param port Port number to check
 * @param hostname Hostname to bind to (default: "127.0.0.1")
 * @returns Promise<boolean> True if port is available
 */
export function isPortAvailable(port: number, hostname = "127.0.0.1"): Promise<boolean> {
  try {
    const listener = Deno.listen({ port, hostname });
    listener.close();
    return Promise.resolve(true);
  } catch (_error) {
    return Promise.resolve(false);
  }
}

/**
 * Waits for a specified amount of time
 * @param ms Milliseconds to wait
 * @returns Promise<void>
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries a function with exponential backoff
 * @param fn Function to retry
 * @param maxAttempts Maximum number of attempts (default: 3)
 * @param baseDelayMs Base delay in milliseconds (default: 100)
 * @returns Promise<T> Result of the function
 * @throws Error from the last failed attempt
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 100,
): Promise<T> {
  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxAttempts) {
        throw lastError;
      }

      // Exponential backoff: 100ms, 200ms, 400ms, etc.
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      await delay(delayMs);
    }
  }

  throw lastError!;
}

/**
 * Creates a timeout promise that rejects after specified time
 * @param ms Timeout in milliseconds
 * @param message Optional timeout message
 * @returns Promise<never>
 */
export function timeout(ms: number, message = "Operation timed out"): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

/**
 * Races a promise against a timeout
 * @param promise Promise to race
 * @param timeoutMs Timeout in milliseconds
 * @param timeoutMessage Optional timeout message
 * @returns Promise<T> Result of the promise or timeout error
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage?: string,
): Promise<T> {
  return Promise.race([
    promise,
    timeout(timeoutMs, timeoutMessage),
  ]);
}

/**
 * Generates a random string for test IDs
 * @param length Length of the string (default: 8)
 * @param charset Character set to use (default: alphanumeric)
 * @returns string Random string
 */
export function randomString(
  length = 8,
  charset = "abcdefghijklmnopqrstuvwxyz0123456789",
): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return result;
}

/**
 * Generates a unique test ID with optional prefix
 * @param prefix Optional prefix (default: "test")
 * @returns string Unique test ID
 */
export function generateTestId(prefix = "test"): string {
  return `${prefix}-${randomString()}-${Date.now()}`;
}

/**
 * Checks if a URL is reachable
 * @param url URL to check
 * @param timeoutMs Timeout in milliseconds (default: 5000)
 * @returns Promise<boolean> True if URL is reachable
 */
export async function isUrlReachable(url: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch (_error) {
    return false;
  }
}

/**
 * Waits for a URL to become reachable
 * @param url URL to wait for
 * @param maxWaitMs Maximum wait time in milliseconds (default: 10000)
 * @param checkIntervalMs Check interval in milliseconds (default: 100)
 * @returns Promise<void>
 * @throws Error if URL doesn't become reachable within maxWaitMs
 */
export async function waitForUrl(
  url: string,
  maxWaitMs = 10000,
  checkIntervalMs = 100,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    if (await isUrlReachable(url)) {
      return;
    }
    await delay(checkIntervalMs);
  }

  throw new Error(`URL ${url} did not become reachable within ${maxWaitMs}ms`);
}

/**
 * Test server interface for consistent server management
 */
export interface TestServer {
  start(): Promise<number>;
  stop(): Promise<void>;
  getPort(): number;
  getBaseUrl(): string;
}

/**
 * Base class for test servers with common functionality
 */
export abstract class BaseTestServer implements TestServer {
  protected port?: number;
  protected server?: Deno.HttpServer;

  abstract start(): Promise<number>;

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.shutdown();
      this.server = undefined;
    }
  }

  getPort(): number {
    if (!this.port) {
      throw new Error("Server not started");
    }
    return this.port;
  }

  getBaseUrl(): string {
    return `http://localhost:${this.getPort()}`;
  }

  protected async findPort(): Promise<number> {
    return await findAvailablePort();
  }
}

/**
 * Test environment setup utilities
 */
export class TestEnvironment {
  private cleanupFunctions: Array<() => Promise<void>> = [];

  /**
   * Registers a cleanup function to be called during teardown
   * @param fn Cleanup function
   */
  onCleanup(fn: () => Promise<void>): void {
    this.cleanupFunctions.push(fn);
  }

  /**
   * Starts a server and registers it for cleanup
   * @param server Test server instance
   * @returns Promise<number> Port number
   */
  async startServer(server: TestServer): Promise<number> {
    const port = await server.start();
    this.onCleanup(() => server.stop());
    return port;
  }

  /**
   * Runs all cleanup functions
   */
  async cleanup(): Promise<void> {
    // Run cleanup functions in reverse order (LIFO)
    for (const cleanup of this.cleanupFunctions.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        console.error("Cleanup error:", error);
      }
    }
    this.cleanupFunctions = [];
  }
}

/**
 * Creates a test environment for managing resources
 * @returns TestEnvironment instance
 */
export function createTestEnvironment(): TestEnvironment {
  return new TestEnvironment();
}
