/**
 * Atlas Message Types
 *
 * Core message types for inter-actor communication in Atlas.
 * Re-exports types from the message envelope system for backward compatibility.
 */

// Re-export core message types from the envelope system
export type {
  AgentExecutePayload,
  AgentExecutionCompletePayload,
  AgentLogPayload,
  AgentProgressPayload,
  AtlasMessageEnvelope,
  MessageChannel,
  MessageDestination,
  MessageDomain,
  MessageError,
  MessagePriority,
  MessageSource,
  WorkerType,
} from "../core/utils/message-envelope.ts";

// Re-export schemas for validation
export {
  AgentExecutePayloadSchema,
  AgentExecutionCompletePayloadSchema,
  AgentLogPayloadSchema,
  AgentProgressPayloadSchema,
  AtlasMessageEnvelopeSchema,
  MessageChannelSchema,
  MessageDestinationSchema,
  MessageDomainSchema,
  MessageErrorSchema,
  MessagePrioritySchema,
  MessageSourceSchema,
  WorkerTypeSchema,
} from "../core/utils/message-envelope.ts";

// Additional session-specific message types
export interface SessionMessage {
  type: string;
  sessionId: string;
  workspaceId: string;
  timestamp: number;
  payload: unknown;
}

export interface SessionProgressMessage extends SessionMessage {
  type: "session.progress";
  payload: {
    current_step: string;
    total_steps?: number;
    estimated_completion_ms?: number;
    progress_percentage?: number;
  };
}

export interface SessionCompleteMessage extends SessionMessage {
  type: "session.complete";
  payload: { success: boolean; result?: unknown; error?: string; execution_time_ms: number };
}

export interface SessionErrorMessage extends SessionMessage {
  type: "session.error";
  payload: { error: string; stack?: string; retryable: boolean; error_code?: string };
}

// Actor communication message types
export interface ActorMessage {
  type: string;
  actorId: string;
  timestamp: number;
  payload: unknown;
}

export interface ActorStateMessage extends ActorMessage {
  type: "actor.state";
  payload: { state: string; previous_state?: string; context?: Record<string, unknown> };
}

export interface ActorErrorMessage extends ActorMessage {
  type: "actor.error";
  payload: { error: string; stack?: string; recovery_action?: string };
}
