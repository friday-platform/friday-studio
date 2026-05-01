import lockfile from "proper-lockfile";

/**
 * Execute a function with an exclusive file lock.
 * For write operations that need mutual exclusion.
 */
export async function withExclusiveLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const release = await lockfile.lock(filePath, {
    retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
