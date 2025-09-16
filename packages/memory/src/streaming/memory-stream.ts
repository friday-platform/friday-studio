/**
 * Memory streaming interfaces and types for incremental memory processing
 */

/**
 * Base properties shared by all memory streams
 */
interface BaseMemoryStream {
  id: string;
  timestamp: number;
  sessionId: string;
  agentId?: string;
  priority: "low" | "normal" | "high";
}

/**
 * Discriminated union of all memory stream types
 */
export type MemoryStream =
  | ({
      type: "semantic_fact";
      data: {
        fact: string;
        confidence: number;
        source: "agent_output" | "user_input" | "system_event";
        context?: Record<string, unknown>;
      };
    } & BaseMemoryStream)
  | ({
      type: "procedural_pattern";
      data: {
        pattern_type: "success" | "failure" | "optimization";
        agent_id: string;
        strategy: string;
        duration_ms: number;
        input_characteristics: Record<string, unknown>;
        outcome: Record<string, unknown>;
      };
    } & BaseMemoryStream)
  | ({
      type: "episodic_event";
      data: {
        event_type: "agent_execution" | "context_change" | "user_interaction" | "session_complete";
        description: string;
        participants: string[];
        outcome: "success" | "failure" | "partial";
        significance: number; // 0-1 scale
        metadata?: {
          inputSummary?: string;
          outputSummary?: string;
          durationMs?: number;
          tokensUsed?: number;
          error?: string;
          [key: string]: unknown;
        };
      };
    } & BaseMemoryStream)
  | ({
      type: "contextual_update";
      data: {
        update_type: "add" | "modify" | "remove";
        key: string;
        old_value?: unknown;
        new_value?: unknown;
        relevance_score: number;
      };
    } & BaseMemoryStream)
  | ({
      type: "agent_result";
      data: {
        agent_id: string;
        input: string;
        output: string;
        duration_ms: number;
        success: boolean;
        tokens_used?: number;
        error?: string;
      };
    } & BaseMemoryStream)
  | ({
      type: "session_complete";
      data: {
        session_id: string;
        total_duration_ms: number;
        agent_count: number;
        success_rate: number;
        final_output: unknown;
        summary?: string;
      };
    } & BaseMemoryStream);

/**
 * Helper types for each specific stream variant
 */
export type SemanticFactStream = Extract<MemoryStream, { type: "semantic_fact" }>;
export type ProceduralPatternStream = Extract<MemoryStream, { type: "procedural_pattern" }>;
export type EpisodicEventStream = Extract<MemoryStream, { type: "episodic_event" }>;
export type ContextualUpdateStream = Extract<MemoryStream, { type: "contextual_update" }>;
export type AgentResultStream = Extract<MemoryStream, { type: "agent_result" }>;
export type SessionCompleteStream = Extract<MemoryStream, { type: "session_complete" }>;

/**
 * Memory stream processing configuration
 */
export interface StreamingConfig {
  queue_max_size: number;
  batch_size: number;
  flush_interval_ms: number;
  background_processing: boolean;
  persistence_enabled: boolean;
  error_retry_attempts: number;
  priority_processing: boolean;
}

/**
 * Memory stream processor interface
 */
export interface MemoryStreamProcessor {
  canProcess(stream: MemoryStream): boolean;
  process(stream: MemoryStream): Promise<void>;
  processBatch(streams: MemoryStream[]): Promise<void>;
}

/**
 * Memory stream queue interface
 */
export interface MemoryStreamQueue {
  push(stream: MemoryStream): Promise<void>;
  pushBatch(streams: MemoryStream[]): Promise<void>;
  pop(): Promise<MemoryStream | null>;
  popBatch(size: number): Promise<MemoryStream[]>;
  size(): number;
  clear(): Promise<void>;
}
