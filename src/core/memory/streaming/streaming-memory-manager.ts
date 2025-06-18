import { logger } from "../../../utils/logger.ts";
import type { CoALAMemoryManager } from "../coala-memory.ts";
import { AsyncMemoryQueue } from "./async-memory-queue.ts";
import {
  AgentResultProcessor,
  EpisodicEventProcessor,
  ProceduralPatternProcessor,
  SemanticFactProcessor,
} from "./memory-stream-processors.ts";
import type {
  AgentResultStream,
  ContextualUpdateStream,
  EpisodicEventStream,
  MemoryStream,
  ProceduralPatternStream,
  SemanticFactStream,
  SessionCompleteStream,
  StreamingConfig,
} from "./memory-stream.ts";

/**
 * Configuration for streaming memory manager
 */
export interface StreamingMemoryConfig extends StreamingConfig {
  dual_write_enabled: boolean; // Enable dual-write for migration safety
  legacy_batch_enabled: boolean; // Keep legacy batch processing as backup
  stream_everything: boolean; // Stream all memory operations vs selective
  performance_tracking: boolean; // Track streaming performance metrics
}

/**
 * Main streaming memory manager that coordinates incremental memory processing
 */
export class StreamingMemoryManager {
  private queue: AsyncMemoryQueue;
  private semanticProcessor: SemanticFactProcessor;
  private proceduralProcessor: ProceduralPatternProcessor;
  private episodicProcessor: EpisodicEventProcessor;
  private agentResultProcessor: AgentResultProcessor;
  private isShutdown = false;
  private performanceMetrics = {
    streamsProcessed: 0,
    totalProcessingTime: 0,
    averageLatency: 0,
    errorCount: 0,
  };

  constructor(
    private memoryManager: CoALAMemoryManager,
    private config: StreamingMemoryConfig,
    private context: { sessionId?: string; workspaceId?: string } = {},
  ) {
    // Initialize queue
    this.queue = new AsyncMemoryQueue(config, context);

    // Initialize processors
    this.semanticProcessor = new SemanticFactProcessor(memoryManager);
    this.proceduralProcessor = new ProceduralPatternProcessor(memoryManager);
    this.episodicProcessor = new EpisodicEventProcessor(memoryManager);
    this.agentResultProcessor = new AgentResultProcessor(
      this.semanticProcessor,
      this.proceduralProcessor,
      this.episodicProcessor,
    );

    // Register processors with queue
    this.queue.registerProcessor("semantic_fact", this.semanticProcessor);
    this.queue.registerProcessor("procedural_pattern", this.proceduralProcessor);
    this.queue.registerProcessor("episodic_event", this.episodicProcessor);
    this.queue.registerProcessor("agent_result", this.agentResultProcessor);
    this.queue.registerProcessor("session_complete", {
      canProcess: (stream) => stream.type === "session_complete",
      process: this.processSessionComplete.bind(this),
      processBatch: async (streams) => {
        for (const stream of streams) {
          await this.processSessionComplete(stream as SessionCompleteStream);
        }
      },
    });

    logger.info("StreamingMemoryManager initialized", {
      queueMaxSize: config.queue_max_size,
      batchSize: config.batch_size,
      backgroundProcessing: config.background_processing,
      dualWriteEnabled: config.dual_write_enabled,
      sessionId: context.sessionId,
    });
  }

  /**
   * Stream agent execution result for immediate memory processing
   */
  async streamAgentResult(
    agentId: string,
    input: any,
    output: any,
    duration: number,
    success: boolean,
    options: { tokensUsed?: number; error?: string; priority?: "low" | "normal" | "high" } = {},
  ): Promise<void> {
    if (this.isShutdown) return;

    const stream: AgentResultStream = {
      id: `agent-result-${crypto.randomUUID()}`,
      type: "agent_result",
      data: {
        agent_id: agentId,
        input,
        output,
        duration_ms: duration,
        success,
        tokens_used: options.tokensUsed,
        error: options.error,
      },
      timestamp: Date.now(),
      sessionId: this.context.sessionId || "unknown",
      agentId,
      priority: options.priority || "normal",
    };

    await this.queue.push(stream);

    logger.debug("Agent result streamed", {
      agentId,
      success,
      duration,
      streamId: stream.id,
      sessionId: this.context.sessionId,
    });
  }

  /**
   * Stream semantic fact for immediate processing
   */
  async streamSemanticFact(
    fact: string,
    confidence: number,
    source: "agent_output" | "user_input" | "system_event",
    context?: Record<string, any>,
    agentId?: string,
  ): Promise<void> {
    if (this.isShutdown) return;

    const stream: SemanticFactStream = {
      id: `semantic-fact-${crypto.randomUUID()}`,
      type: "semantic_fact",
      data: {
        fact,
        confidence,
        source,
        context,
      },
      timestamp: Date.now(),
      sessionId: this.context.sessionId || "unknown",
      agentId,
      priority: "normal",
    };

    await this.queue.push(stream);

    logger.debug("Semantic fact streamed", {
      fact: fact.substring(0, 100),
      confidence,
      source,
      streamId: stream.id,
      sessionId: this.context.sessionId,
    });
  }

  /**
   * Stream procedural pattern for immediate processing
   */
  async streamProceduralPattern(
    patternType: "success" | "failure" | "optimization",
    agentId: string,
    strategy: string,
    duration: number,
    inputCharacteristics: Record<string, any>,
    outcome: Record<string, any>,
  ): Promise<void> {
    if (this.isShutdown) return;

    const stream: ProceduralPatternStream = {
      id: `procedural-pattern-${crypto.randomUUID()}`,
      type: "procedural_pattern",
      data: {
        pattern_type: patternType,
        agent_id: agentId,
        strategy,
        duration_ms: duration,
        input_characteristics: inputCharacteristics,
        outcome,
      },
      timestamp: Date.now(),
      sessionId: this.context.sessionId || "unknown",
      agentId,
      priority: "normal",
    };

    await this.queue.push(stream);

    logger.debug("Procedural pattern streamed", {
      patternType,
      agentId,
      strategy,
      duration,
      streamId: stream.id,
      sessionId: this.context.sessionId,
    });
  }

  /**
   * Stream episodic event for immediate processing
   */
  async streamEpisodicEvent(
    eventType: "agent_execution" | "context_change" | "user_interaction",
    description: string,
    participants: string[],
    outcome: "success" | "failure" | "partial",
    significance: number,
  ): Promise<void> {
    if (this.isShutdown) return;

    const stream: EpisodicEventStream = {
      id: `episodic-event-${crypto.randomUUID()}`,
      type: "episodic_event",
      data: {
        event_type: eventType,
        description,
        participants,
        outcome,
        significance,
      },
      timestamp: Date.now(),
      sessionId: this.context.sessionId || "unknown",
      priority: significance > 0.7 ? "high" : "normal",
    };

    await this.queue.push(stream);

    logger.debug("Episodic event streamed", {
      eventType,
      description: description.substring(0, 100),
      outcome,
      significance,
      streamId: stream.id,
      sessionId: this.context.sessionId,
    });
  }

  /**
   * Stream session completion for final summary processing
   */
  async streamSessionComplete(
    sessionId: string,
    totalDuration: number,
    agentCount: number,
    successRate: number,
    finalOutput: any,
    summary?: string,
  ): Promise<void> {
    if (this.isShutdown) return;

    const stream: SessionCompleteStream = {
      id: `session-complete-${crypto.randomUUID()}`,
      type: "session_complete",
      data: {
        session_id: sessionId,
        total_duration_ms: totalDuration,
        agent_count: agentCount,
        success_rate: successRate,
        final_output: finalOutput,
        summary,
      },
      timestamp: Date.now(),
      sessionId,
      priority: "high", // Session completion is high priority
    };

    await this.queue.push(stream);

    logger.info("Session completion streamed", {
      sessionId,
      totalDuration,
      agentCount,
      successRate,
      streamId: stream.id,
    });
  }

  /**
   * Process session complete stream
   */
  private async processSessionComplete(stream: SessionCompleteStream): Promise<void> {
    const startTime = Date.now();

    try {
      // Store lightweight session summary
      await this.memoryManager.storeSessionSummary({
        id: stream.id,
        sessionId: stream.data.session_id,
        totalDuration: stream.data.total_duration_ms,
        agentCount: stream.data.agent_count,
        successRate: stream.data.success_rate,
        summary: stream.data.summary,
        timestamp: stream.timestamp,
      });

      logger.info("Session completion processed", {
        sessionId: stream.data.session_id,
        duration: Date.now() - startTime,
        streamId: stream.id,
      });
    } catch (error) {
      logger.error("Failed to process session completion stream", {
        streamId: stream.id,
        sessionId: stream.data.session_id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get queue status and performance metrics
   */
  getStatus(): {
    queueSize: number;
    isProcessing: boolean;
    metrics: {
      streamsProcessed: number;
      totalProcessingTime: number;
      averageLatency: number;
      errorCount: number;
    };
    config: StreamingMemoryConfig;
  } {
    return {
      queueSize: this.queue.size(),
      isProcessing: !this.isShutdown,
      metrics: { ...this.performanceMetrics },
      config: { ...this.config },
    };
  }

  /**
   * Force process all queued streams immediately
   */
  async flush(): Promise<void> {
    logger.info("Flushing streaming memory queue", {
      queueSize: this.queue.size(),
      sessionId: this.context.sessionId,
    });

    // Process all remaining items
    while (this.queue.size() > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    logger.info("Streaming memory queue flushed", {
      sessionId: this.context.sessionId,
    });
  }

  /**
   * Shutdown streaming memory manager
   */
  async shutdown(): Promise<void> {
    if (this.isShutdown) return;

    this.isShutdown = true;

    logger.info("Shutting down StreamingMemoryManager", {
      queueSize: this.queue.size(),
      streamsProcessed: this.performanceMetrics.streamsProcessed,
      sessionId: this.context.sessionId,
    });

    await this.queue.shutdown();

    logger.info("StreamingMemoryManager shutdown complete", {
      finalMetrics: this.performanceMetrics,
      sessionId: this.context.sessionId,
    });
  }

  /**
   * Enable dual-write mode for safe migration
   */
  enableDualWrite(): void {
    this.config.dual_write_enabled = true;
    logger.info("Dual-write mode enabled", {
      sessionId: this.context.sessionId,
    });
  }

  /**
   * Disable dual-write mode after migration
   */
  disableDualWrite(): void {
    this.config.dual_write_enabled = false;
    logger.info("Dual-write mode disabled", {
      sessionId: this.context.sessionId,
    });
  }
}
