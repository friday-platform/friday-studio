/**
 * Test utilities for Atlas test suite
 * Common helper functions and utilities for testing
 */

/**
 * Sleep for a specified number of milliseconds (alias for consistency)
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap a promise with a timeout
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage?: string,
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(errorMessage || `Operation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  return Promise.race([promise, timeoutPromise]);
}

/**
 * Create a test workspace with temporary files
 */
export async function createTestWorkspace(
  files: Record<string, string>,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas-test-workspace-" });

  // Write all files to the temp directory
  for (const [filename, content] of Object.entries(files)) {
    const filePath = `${tempDir}/${filename}`;
    await Deno.writeTextFile(filePath, content);
  }

  return {
    path: tempDir,
    cleanup: async () => {
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}

/**
 * Find an available port starting from a given port
 */
export async function findAvailablePort(startPort = 8080): Promise<number> {
  let port = startPort;
  while (!(await isPortAvailable(port)) && port < 65535) {
    port++;
  }
  return port;
}

/**
 * Check if a port is available
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const listener = Deno.listen({ port });
      listener.close();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}
