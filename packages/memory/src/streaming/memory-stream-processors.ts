import { logger } from "../../../../src/utils/logger.ts";
import type { CoALAMemoryManager } from "../coala-memory.ts";
import type {
  AgentResultStream,
  ContextualUpdateStream,
  EpisodicEventStream,
  MemoryStream,
  MemoryStreamProcessor,
  ProceduralPatternStream,
  SemanticFactStream,
  SessionCompleteStream,
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
  constructor(
    private semanticProcessor: SemanticFactProcessor,
    private proceduralProcessor: ProceduralPatternProcessor,
    private episodicProcessor: EpisodicEventProcessor,
  ) {}

  canProcess(stream: MemoryStream): boolean {
    return stream.type === "agent_result";
  }

  async process(stream: AgentResultStream): Promise<void> {
    const startTime = Date.now();

    try {
      // Extract semantic fact from agent result
      const semanticFact: SemanticFactStream = {
        id: `${stream.id}-semantic`,
        type: "semantic_fact",
        data: {
          fact: this.extractSemanticFact(stream.data),
          confidence: stream.data.success ? 0.8 : 0.3,
          source: "agent_output",
          context: {
            agentId: stream.data.agent_id,
            inputSize: JSON.stringify(stream.data.input).length,
            outputSize: JSON.stringify(stream.data.output).length,
          },
        },
        timestamp: stream.timestamp,
        sessionId: stream.sessionId,
        agentId: stream.agentId,
        priority: "normal",
      };

      // Extract procedural pattern
      const proceduralPattern: ProceduralPatternStream = {
        id: `${stream.id}-procedural`,
        type: "procedural_pattern",
        data: {
          pattern_type: stream.data.success ? "success" : "failure",
          agent_id: stream.data.agent_id,
          strategy: "llm_execution",
          duration_ms: stream.data.duration_ms,
          input_characteristics: this.analyzeInputCharacteristics(stream.data.input),
          outcome: {
            success: stream.data.success,
            tokensUsed: stream.data.tokens_used,
            error: stream.data.error,
          },
        },
        timestamp: stream.timestamp,
        sessionId: stream.sessionId,
        agentId: stream.agentId,
        priority: "normal",
      };

      // Extract episodic event
      const episodicEvent: EpisodicEventStream = {
        id: `${stream.id}-episodic`,
        type: "episodic_event",
        data: {
          event_type: "agent_execution",
          description: `Agent ${stream.data.agent_id} ${
            stream.data.success ? "successfully" : "unsuccessfully"
          } executed`,
          participants: [stream.data.agent_id],
          outcome: stream.data.success ? "success" : "failure",
          significance: this.calculateSignificance(stream.data),
        },
        timestamp: stream.timestamp,
        sessionId: stream.sessionId,
        agentId: stream.agentId,
        priority: "normal",
      };

      // Process all extracted memories
      await Promise.all([
        this.semanticProcessor.process(semanticFact),
        this.proceduralProcessor.process(proceduralPattern),
        this.episodicProcessor.process(episodicEvent),
      ]);

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

  private extractSemanticFact(data: any): string {
    // Simple fact extraction - could be enhanced with LLM
    const input = JSON.stringify(data.input);
    const output = JSON.stringify(data.output);

    if (data.success) {
      return `Agent ${data.agent_id} transformed input of ${input.length} chars to output of ${output.length} chars`;
    } else {
      return `Agent ${data.agent_id} failed to process input: ${data.error || "unknown error"}`;
    }
  }

  private analyzeInputCharacteristics(input: any): Record<string, any> {
    const inputStr = JSON.stringify(input);
    return {
      length: inputStr.length,
      type: typeof input,
      hasMessage: "message" in input,
      complexity: inputStr.length > 100 ? "high" : inputStr.length > 20 ? "medium" : "low",
    };
  }

  private calculateSignificance(data: any): number {
    // Calculate significance based on success, duration, and complexity
    let significance = 0.5; // Base significance

    if (data.success) significance += 0.2;
    if (data.duration_ms > 2000) significance += 0.1; // Long duration = more significant
    if (data.tokens_used && data.tokens_used > 1000) significance += 0.1;
    if (data.error) significance += 0.2; // Errors are significant for learning

    return Math.min(1.0, significance);
  }
}
