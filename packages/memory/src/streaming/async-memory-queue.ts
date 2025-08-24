import { logger } from "@atlas/logger";
import type {
  MemoryStream,
  MemoryStreamProcessor,
  MemoryStreamQueue,
  StreamingConfig,
} from "./memory-stream.ts";

/**
 * High-performance async queue for memory streams with background processing
 */
export class AsyncMemoryQueue implements MemoryStreamQueue {
  private queue: MemoryStream[] = [];
  private processing = false;
  private processors: Map<string, MemoryStreamProcessor> = new Map();
  private flushTimer?: number;

  constructor(
    private config: StreamingConfig,
    private context: { sessionId?: string; workspaceId?: string } = {},
  ) {
    if (config.background_processing && config.flush_interval_ms > 0) {
      this.startPeriodicFlush();
    }
  }

  async push(stream: MemoryStream): Promise<void> {
    // Check queue capacity
    if (this.queue.length >= this.config.queue_max_size) {
      logger.warn("Memory stream queue at capacity, dropping oldest stream", {
        queueSize: this.queue.length,
        maxSize: this.config.queue_max_size,
        sessionId: this.context.sessionId,
      });
      this.queue.shift(); // Drop oldest
    }

    // Add stream with timestamp
    const timestampedStream = { ...stream, timestamp: stream.timestamp || Date.now() };

    // Priority queue: high priority items go to front
    if (stream.priority === "high") {
      this.queue.unshift(timestampedStream);
    } else {
      this.queue.push(timestampedStream);
    }

    logger.debug("Memory stream queued", {
      streamId: stream.id,
      type: stream.type,
      priority: stream.priority,
      queueSize: this.queue.length,
      sessionId: this.context.sessionId,
    });

    // Process immediately if not background mode or high priority
    if (!this.config.background_processing || stream.priority === "high") {
      this.processIfNeeded();
    }
  }

  async pushBatch(streams: MemoryStream[]): Promise<void> {
    const timestampedStreams = streams.map((stream) => ({
      ...stream,
      timestamp: stream.timestamp || Date.now(),
    }));

    // Check capacity and make room if needed
    const available = this.config.queue_max_size - this.queue.length;
    if (timestampedStreams.length > available) {
      const toRemove = timestampedStreams.length - available;
      this.queue.splice(0, toRemove);
      logger.warn("Memory stream queue overflow, dropped oldest streams", {
        droppedCount: toRemove,
        sessionId: this.context.sessionId,
      });
    }

    this.queue.push(...timestampedStreams);

    logger.debug("Memory stream batch queued", {
      batchSize: streams.length,
      queueSize: this.queue.length,
      sessionId: this.context.sessionId,
    });

    this.processIfNeeded();
  }

  async pop(): Promise<MemoryStream | null> {
    return this.queue.shift() || null;
  }

  async popBatch(size: number): Promise<MemoryStream[]> {
    const batch = this.queue.splice(0, Math.min(size, this.queue.length));
    return batch;
  }

  size(): number {
    return this.queue.length;
  }

  async clear(): Promise<void> {
    const clearedCount = this.queue.length;
    this.queue = [];

    logger.info("Memory stream queue cleared", { clearedCount, sessionId: this.context.sessionId });
  }

  /**
   * Register a processor for specific stream types
   */
  registerProcessor(type: string, processor: MemoryStreamProcessor): void {
    this.processors.set(type, processor);
    logger.debug("Memory stream processor registered", {
      type,
      processorCount: this.processors.size,
    });
  }

  /**
   * Process streams if not already processing
   */
  private async processIfNeeded(): Promise<void> {
    if (this.processing) return;
    if (this.queue.length === 0) return;

    this.processing = true;

    try {
      await this.processQueue();
    } catch (error) {
      logger.error("Error processing memory stream queue", {
        error: error instanceof Error ? error.message : String(error),
        queueSize: this.queue.length,
        sessionId: this.context.sessionId,
      });
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process the queue with batch optimization
   */
  private async processQueue(): Promise<void> {
    const startTime = Date.now();
    let processedCount = 0;

    while (this.queue.length > 0) {
      const batchSize = Math.min(this.config.batch_size, this.queue.length);
      const batch = await this.popBatch(batchSize);

      // Group by processor type for batch processing
      const streamsByType = new Map<string, MemoryStream[]>();

      for (const stream of batch) {
        const processor = this.processors.get(stream.type);
        if (processor) {
          if (!streamsByType.has(stream.type)) {
            streamsByType.set(stream.type, []);
          }
          streamsByType.get(stream.type)!.push(stream);
        } else {
          logger.warn("No processor found for stream type", {
            streamId: stream.id,
            type: stream.type,
            sessionId: this.context.sessionId,
          });
        }
      }

      // Process each type as a batch
      const processingPromises = Array.from(streamsByType.entries()).map(
        async ([type, streams]) => {
          const processor = this.processors.get(type)!;

          try {
            if (streams.length === 1) {
              await processor.process(streams[0]);
            } else {
              await processor.processBatch(streams);
            }

            logger.debug("Memory stream batch processed", {
              type,
              count: streams.length,
              sessionId: this.context.sessionId,
            });
          } catch (error) {
            logger.error("Error processing memory stream batch", {
              type,
              count: streams.length,
              error: error instanceof Error ? error.message : String(error),
              sessionId: this.context.sessionId,
            });

            // Retry individual streams if batch fails
            if (this.config.error_retry_attempts > 0) {
              await this.retryStreams(streams, processor);
            }
          }
        },
      );

      await Promise.all(processingPromises);
      processedCount += batch.length;

      // Yield control to prevent blocking
      if (processedCount % (this.config.batch_size * 3) === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    const duration = Date.now() - startTime;
    logger.debug("Memory stream queue processing complete", {
      processedCount,
      duration,
      sessionId: this.context.sessionId,
    });
  }

  /**
   * Retry failed streams individually
   */
  private async retryStreams(
    streams: MemoryStream[],
    processor: MemoryStreamProcessor,
  ): Promise<void> {
    for (const stream of streams) {
      for (let attempt = 1; attempt <= this.config.error_retry_attempts; attempt++) {
        try {
          await processor.process(stream);
          logger.debug("Memory stream retry successful", {
            streamId: stream.id,
            attempt,
            sessionId: this.context.sessionId,
          });
          break;
        } catch (error) {
          logger.warn("Memory stream retry failed", {
            streamId: stream.id,
            attempt,
            maxAttempts: this.config.error_retry_attempts,
            error: error instanceof Error ? error.message : String(error),
            sessionId: this.context.sessionId,
          });

          if (attempt === this.config.error_retry_attempts) {
            logger.error("Memory stream permanently failed after retries", {
              streamId: stream.id,
              type: stream.type,
              sessionId: this.context.sessionId,
            });
          }
        }
      }
    }
  }

  /**
   * Start periodic background flushing
   */
  private startPeriodicFlush(): void {
    this.flushTimer = setInterval(() => {
      if (this.queue.length > 0) {
        this.processIfNeeded();
      }
    }, this.config.flush_interval_ms);
  }

  /**
   * Stop periodic flushing and process remaining items
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Process any remaining streams
    if (this.queue.length > 0) {
      logger.info("Processing remaining memory streams before shutdown", {
        remainingCount: this.queue.length,
        sessionId: this.context.sessionId,
      });
      await this.processIfNeeded();
    }

    logger.info("Memory stream queue shutdown complete", { sessionId: this.context.sessionId });
  }
}
