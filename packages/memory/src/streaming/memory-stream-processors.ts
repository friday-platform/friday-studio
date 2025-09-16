import { logger } from "@atlas/logger";
import type { CoALAMemoryManager } from "../coala-memory.ts";
import type {
  AgentResultStream,
  EpisodicEventStream,
  MemoryStream,
  MemoryStreamProcessor,
  ProceduralPatternStream,
  SemanticFactStream,
} from "./memory-stream.ts";

/**
 * Processor for semantic fact streams
 */
export class SemanticFactProcessor implements MemoryStreamProcessor {
  constructor(private memoryManager: CoALAMemoryManager) {}

  canProcess(stream: MemoryStream): boolean {
    return stream.type === "semantic_fact";
  }

  async process(stream: SemanticFactStream): Promise<void> {
    const startTime = Date.now();

    try {
      // Store semantic fact incrementally
      await this.memoryManager.storeFact({
        id: stream.id,
        content: stream.data.fact,
        confidence: stream.data.confidence,
        source: stream.data.source,
        timestamp: stream.timestamp,
        sessionId: stream.sessionId,
        agentId: stream.agentId,
        context: stream.data.context,
      });

      logger.debug("Semantic fact processed", {
        streamId: stream.id,
        fact: stream.data.fact,
        confidence: stream.data.confidence,
        duration: Date.now() - startTime,
        sessionId: stream.sessionId,
      });
    } catch (error) {
      logger.error("Failed to process semantic fact stream", {
        streamId: stream.id,
        error: error instanceof Error ? error.message : String(error),
        sessionId: stream.sessionId,
      });
      throw error;
    }
  }

  async processBatch(streams: MemoryStream[]): Promise<void> {
    const startTime = Date.now();
    const facts = streams
      .filter((s): s is SemanticFactStream => s.type === "semantic_fact")
      .map((stream) => ({
        id: stream.id,
        content: stream.data.fact,
        confidence: stream.data.confidence,
        source: stream.data.source,
        timestamp: stream.timestamp,
        sessionId: stream.sessionId,
        agentId: stream.agentId,
        context: stream.data.context,
      }));

    try {
      await this.memoryManager.storeFactsBatch(facts);

      logger.debug("Semantic fact batch processed", {
        count: facts.length,
        duration: Date.now() - startTime,
      });
    } catch (error) {
      logger.error("Failed to process semantic fact batch", {
        count: facts.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

/**
 * Processor for procedural pattern streams
 */
export class ProceduralPatternProcessor implements MemoryStreamProcessor {
  constructor(private memoryManager: CoALAMemoryManager) {}

  canProcess(stream: MemoryStream): boolean {
    return stream.type === "procedural_pattern";
  }

  async process(stream: ProceduralPatternStream): Promise<void> {
    const startTime = Date.now();

    try {
      await this.memoryManager.storePattern({
        id: stream.id,
        type: stream.data.pattern_type,
        agentId: stream.data.agent_id,
        strategy: stream.data.strategy,
        duration: stream.data.duration_ms,
        inputCharacteristics: stream.data.input_characteristics,
        outcome: stream.data.outcome,
        timestamp: stream.timestamp,
        sessionId: stream.sessionId,
      });

      logger.debug("Procedural pattern processed", {
        streamId: stream.id,
        agentId: stream.data.agent_id,
        patternType: stream.data.pattern_type,
        duration: Date.now() - startTime,
        sessionId: stream.sessionId,
      });
    } catch (error) {
      logger.error("Failed to process procedural pattern stream", {
        streamId: stream.id,
        error: error instanceof Error ? error.message : String(error),
        sessionId: stream.sessionId,
      });
      throw error;
    }
  }

  async processBatch(streams: MemoryStream[]): Promise<void> {
    const startTime = Date.now();
    const patterns = streams
      .filter((s): s is ProceduralPatternStream => s.type === "procedural_pattern")
      .map((stream) => ({
        id: stream.id,
        type: stream.data.pattern_type,
        agentId: stream.data.agent_id,
        strategy: stream.data.strategy,
        duration: stream.data.duration_ms,
        inputCharacteristics: stream.data.input_characteristics,
        outcome: stream.data.outcome,
        timestamp: stream.timestamp,
        sessionId: stream.sessionId,
      }));

    try {
      await this.memoryManager.storePatternsBatch(patterns);

      logger.debug("Procedural pattern batch processed", {
        count: patterns.length,
        duration: Date.now() - startTime,
      });
    } catch (error) {
      logger.error("Failed to process procedural pattern batch", {
        count: patterns.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

/**
 * Processor for episodic event streams
 */
export class EpisodicEventProcessor implements MemoryStreamProcessor {
  constructor(private memoryManager: CoALAMemoryManager) {}

  canProcess(stream: MemoryStream): boolean {
    return stream.type === "episodic_event";
  }

  async process(stream: EpisodicEventStream): Promise<void> {
    const startTime = Date.now();

    try {
      await this.memoryManager.storeEpisode({
        id: stream.id,
        eventType: stream.data.event_type,
        description: stream.data.description,
        participants: stream.data.participants,
        outcome: stream.data.outcome,
        significance: stream.data.significance,
        timestamp: stream.timestamp,
        sessionId: stream.sessionId,
      });

      logger.debug("Episodic event processed", {
        streamId: stream.id,
        eventType: stream.data.event_type,
        significance: stream.data.significance,
        duration: Date.now() - startTime,
        sessionId: stream.sessionId,
      });
    } catch (error) {
      logger.error("Failed to process episodic event stream", {
        streamId: stream.id,
        error: error instanceof Error ? error.message : String(error),
        sessionId: stream.sessionId,
      });
      throw error;
    }
  }

  async processBatch(streams: MemoryStream[]): Promise<void> {
    const startTime = Date.now();
    const episodes = streams
      .filter((s): s is EpisodicEventStream => s.type === "episodic_event")
      .map((stream) => ({
        id: stream.id,
        eventType: stream.data.event_type,
        description: stream.data.description,
        participants: stream.data.participants,
        outcome: stream.data.outcome,
        significance: stream.data.significance,
        timestamp: stream.timestamp,
        sessionId: stream.sessionId,
      }));

    try {
      await this.memoryManager.storeEpisodesBatch(episodes);

      logger.debug("Episodic event batch processed", {
        count: episodes.length,
        duration: Date.now() - startTime,
      });
    } catch (error) {
      logger.error("Failed to process episodic event batch", {
        count: episodes.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

/**
 * Processor for agent result streams - extracts multiple memory types
 */
export class AgentResultProcessor implements MemoryStreamProcessor {
  constructor(private memoryManager: CoALAMemoryManager) {}

  canProcess(stream: MemoryStream): boolean {
    return stream.type === "agent_result";
  }

  async process(stream: AgentResultStream): Promise<void> {
    const startTime = Date.now();

    try {
      // Write a WORKING memory entry capturing the raw agent result for session context
      try {
        const tags = ["working", "session", "agent", stream.data.agent_id];
        this.memoryManager.rememberWorking(
          stream.sessionId,
          {
            kind: "agent_result",
            agentId: stream.data.agent_id,
            input: stream.data.input,
            output: stream.data.output,
            success: stream.data.success.toString(),
            error: stream.data.error || "",
            durationMs: stream.data.duration_ms.toString(),
            timestamp: stream.timestamp.toString(),
          },
          { tags, relevanceScore: 0.65, confidence: 0.9 },
        );
      } catch (e) {
        logger.debug("Failed to write working memory for agent_result", {
          error: e instanceof Error ? e.message : String(e),
          streamId: stream.id,
        });
      }

      logger.debug("Agent result processed and decomposed into memory streams", {
        streamId: stream.id,
        agentId: stream.data.agent_id,
        success: stream.data.success,
        duration: Date.now() - startTime,
        sessionId: stream.sessionId,
      });
    } catch (error) {
      logger.error("Failed to process agent result stream", {
        streamId: stream.id,
        error: error instanceof Error ? error.message : String(error),
        sessionId: stream.sessionId,
      });
      throw error;
    }
  }

  async processBatch(streams: MemoryStream[]): Promise<void> {
    // Process each agent result individually as they need decomposition
    const promises = streams
      .filter((s): s is AgentResultStream => s.type === "agent_result")
      .map((stream) => this.process(stream));

    await Promise.all(promises);
  }
}

/**
 * Processor for working context streams
 * Creates WORKING memory entries from agent results and contextual updates
 */
export class WorkingContextProcessor implements MemoryStreamProcessor {
  constructor(private memoryManager: CoALAMemoryManager) {}

  canProcess(stream: MemoryStream): boolean {
    return stream.type === "agent_result" || stream.type === "contextual_update";
  }

  async process(stream: MemoryStream): Promise<void> {
    try {
      const sessionId = stream.sessionId || "unknown";
      if (stream.type === "agent_result") {
        const data = stream.data;
        const tags = ["working", "session", "agent", data.agent_id];
        this.memoryManager.rememberWorking(
          sessionId,
          {
            kind: "agent_result",
            agentId: data.agent_id,
            input: JSON.stringify(data.input),
            output: JSON.stringify(data.output),
            success: data.success.toString(),
            tokensUsed: data.tokens_used?.toString() || "",
            error: data.error || "",
            durationMs: data.duration_ms.toString(),
            timestamp: stream.timestamp.toString(),
          },
          { tags, relevanceScore: 0.65, confidence: 0.9 },
        );
      } else if (stream.type === "contextual_update") {
        const ctx = stream.data;
        const tags = ["working", "session", "context"];
        this.memoryManager.rememberWorking(
          sessionId,
          {
            kind: "context_update",
            updateType: ctx.update_type,
            key: ctx.key,
            oldValue: JSON.stringify(ctx.old_value),
            newValue: JSON.stringify(ctx.new_value),
            relevanceScore: ctx.relevance_score.toString(),
            timestamp: stream.timestamp.toString(),
          },
          { tags, relevanceScore: ctx.relevance_score ?? 0.6, confidence: 0.9 },
        );
      }
    } catch (error) {
      logger.warn("Failed to process working context stream", {
        error: error instanceof Error ? error.message : String(error),
        streamId: stream.id,
        type: stream.type,
      });
    }
  }

  async processBatch(streams: MemoryStream[]): Promise<void> {
    for (const s of streams) {
      await this.process(s);
    }
  }
}
