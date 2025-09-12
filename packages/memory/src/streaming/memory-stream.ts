/**
 * Memory streaming interfaces and types for incremental memory processing
 */

export type MemoryStreamType =
  | "semantic_fact"
  | "procedural_pattern"
  | "episodic_event"
  | "contextual_update"
  | "session_complete"
  | "agent_result";

export interface MemoryStream {
  id: string;
  type: MemoryStreamType;
  data: unknown;
  timestamp: number;
  sessionId: string;
  agentId?: string;
  priority: "low" | "normal" | "high";
}

export interface SemanticFactStream extends MemoryStream {
  type: "semantic_fact";
  data: {
    fact: string;
    confidence: number;
    source: "agent_output" | "user_input" | "system_event";
    context?: Record<string, unknown>;
  };
}

export interface ProceduralPatternStream extends MemoryStream {
  type: "procedural_pattern";
  data: {
    pattern_type: "success" | "failure" | "optimization";
    agent_id: string;
    strategy: string;
    duration_ms: number;
    input_characteristics: Record<string, unknown>;
    outcome: Record<string, unknown>;
  };
}

export interface EpisodicEventStream extends MemoryStream {
  type: "episodic_event";
  data: {
    event_type: "agent_execution" | "context_change" | "user_interaction";
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
}

export interface ContextualUpdateStream extends MemoryStream {
  type: "contextual_update";
  data: {
    update_type: "add" | "modify" | "remove";
    key: string;
    old_value?: unknown;
    new_value?: unknown;
    relevance_score: number;
  };
}

export interface AgentResultStream extends MemoryStream {
  type: "agent_result";
  data: {
    agent_id: string;
    input: unknown;
    output: unknown;
    duration_ms: number;
    success: boolean;
    tokens_used?: number;
    error?: string;
  };
}

export interface SessionCompleteStream extends MemoryStream {
  type: "session_complete";
  data: {
    session_id: string;
    total_duration_ms: number;
    agent_count: number;
    success_rate: number;
    final_output: unknown;
    summary?: string;
  };
}

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
