/**
 * File write coordinator to prevent concurrent writes to the same file.
 * This prevents "Too many open files" errors when multiple loggers
 * try to write to the same files simultaneously.
 */

class Mutex {
  private locked = false;
  private waiters: (() => void)[] = [];

  async acquire(): Promise<() => void> {
    while (this.locked) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.locked = true;
    return () => {
      this.locked = false;
      this.waiters.shift()?.();
    };
  }
}

const fileMutexes = new Map<string, Mutex>();

export async function executeWrite(
  filePath: string,
  writeOperation: () => Promise<void>,
): Promise<void> {
  let mutex = fileMutexes.get(filePath);
  if (!mutex) {
    mutex = new Mutex();
    fileMutexes.set(filePath, mutex);
  }
  const release = await mutex.acquire();
  try {
    await writeOperation();
  } finally {
    release();
  }
}
