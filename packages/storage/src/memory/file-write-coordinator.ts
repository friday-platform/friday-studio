/**
 * Global file write coordinator to prevent concurrent writes to the same file
 * from multiple memory manager instances.
 *
 * This prevents "Too many open files" errors when multiple memory managers
 * try to write to the same files simultaneously.
 */

// Simple mutex implementation for file write coordination
class Mutex {
  private locked = false;
  private waiters: (() => void)[] = [];

  async acquire(): Promise<() => void> {
    while (this.locked) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }

    this.locked = true;

    return () => {
      this.locked = false;
      const next = this.waiters.shift();
      if (next) {
        next();
      }
    };
  }
}

interface FileWriteTask {
  filePath: string;
  writeOperation: () => Promise<void>;
}

class FileWriteCoordinator {
  private static instance: FileWriteCoordinator;
  private fileMutexes = new Map<string, Mutex>();
  private writeQueue = new Map<string, FileWriteTask[]>();
  private isProcessing = new Map<string, boolean>();

  private constructor() {}

  static getInstance(): FileWriteCoordinator {
    if (!FileWriteCoordinator.instance) {
      FileWriteCoordinator.instance = new FileWriteCoordinator();
    }
    return FileWriteCoordinator.instance;
  }

  /**
   * Get or create a mutex for a specific file path
   */
  private getMutex(filePath: string): Mutex {
    if (!this.fileMutexes.has(filePath)) {
      this.fileMutexes.set(filePath, new Mutex());
    }
    return this.fileMutexes.get(filePath)!;
  }

  /**
   * Execute a write operation for a file, ensuring no concurrent writes
   */
  async executeWrite(filePath: string, writeOperation: () => Promise<void>): Promise<void> {
    const mutex = this.getMutex(filePath);

    // Use the mutex to ensure only one write happens at a time for this file
    const release = await mutex.acquire();
    try {
      await writeOperation();
    } finally {
      release();
    }
  }

  /**
   * Queue a write operation for batch processing
   */
  async queueWrite(filePath: string, writeOperation: () => Promise<void>): Promise<void> {
    if (!this.writeQueue.has(filePath)) {
      this.writeQueue.set(filePath, []);
    }

    this.writeQueue.get(filePath)!.push({ filePath, writeOperation });

    // Process the queue if not already processing
    if (!this.isProcessing.get(filePath)) {
      await this.processQueue(filePath);
    }
  }

  /**
   * Process queued writes for a specific file
   */
  private async processQueue(filePath: string): Promise<void> {
    if (this.isProcessing.get(filePath)) {
      return;
    }

    this.isProcessing.set(filePath, true);

    try {
      const queue = this.writeQueue.get(filePath) || [];
      while (queue.length > 0) {
        const task = queue.shift()!;
        await this.executeWrite(task.filePath, task.writeOperation);
      }
    } finally {
      this.isProcessing.set(filePath, false);

      // Check if more items were added while processing
      const queue = this.writeQueue.get(filePath) || [];
      if (queue.length > 0) {
        await this.processQueue(filePath);
      }
    }
  }

  /**
   * Get statistics about the coordinator
   */
  getStats(): {
    activeMutexes: number;
    queuedWrites: Map<string, number>;
    processingFiles: string[];
  } {
    const queuedWrites = new Map<string, number>();
    for (const [path, queue] of this.writeQueue.entries()) {
      if (queue.length > 0) {
        queuedWrites.set(path, queue.length);
      }
    }

    const processingFiles = Array.from(this.isProcessing.entries())
      .filter(([_, processing]) => processing)
      .map(([path]) => path);

    return {
      activeMutexes: this.fileMutexes.size,
      queuedWrites,
      processingFiles,
    };
  }
}

export { FileWriteCoordinator };
