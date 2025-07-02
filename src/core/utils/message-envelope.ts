/**
 * Atlas Message Envelope System
 *
 * Unified message format for all worker communication in Atlas with Zod validation.
 * Provides standardized structure for observability, correlation, and reliability.
 */

import { z } from "zod/v4";

// ===== ZOD SCHEMAS =====

export const WorkerTypeSchema = z.enum([
  "workspace-supervisor",
  "session-supervisor",
  "agent-supervisor",
  "agent-execution",
  "manager",
]);

export const MessageDomainSchema = z.enum(["workspace", "session", "agent", "manager"]);

export const MessageChannelSchema = z.enum(["direct", "broadcast", "multicast"]);

export const MessagePrioritySchema = z.enum(["low", "normal", "high", "critical"]);

export const MessageSourceSchema = z.object({
  workerId: z.string(),
  workerType: WorkerTypeSchema,
  sessionId: z.string().optional(),
  workspaceId: z.string().optional(),
});

export const MessageDestinationSchema = z.object({
  workerId: z.string().optional(),
  workerType: WorkerTypeSchema.optional(),
  sessionId: z.string().optional(),
  workspaceId: z.string().optional(),
});

export const MessageErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  retryable: z.boolean(),
});

export const AtlasMessageEnvelopeSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  domain: MessageDomainSchema,
  source: MessageSourceSchema,
  destination: MessageDestinationSchema.optional(),
  timestamp: z.number().positive(),
  correlationId: z.uuid().optional(),
  parentMessageId: z.uuid().optional(),
  sequence: z.number().optional(),
  channel: MessageChannelSchema,
  broadcastChannel: z.string().optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  traceHeaders: z.record(z.string(), z.unknown()).optional(),
  payload: z.unknown(),
  error: MessageErrorSchema.optional(),
  priority: MessagePrioritySchema,
  timeout: z.number().positive().optional(),
  retryCount: z.number().nonnegative().optional(),
  acknowledgmentRequired: z.boolean().optional(),
});

// ===== TYPE EXPORTS =====

export type WorkerType = z.infer<typeof WorkerTypeSchema>;
export type MessageDomain = z.infer<typeof MessageDomainSchema>;
export type MessageChannel = z.infer<typeof MessageChannelSchema>;
export type MessagePriority = z.infer<typeof MessagePrioritySchema>;
export type MessageSource = z.infer<typeof MessageSourceSchema>;
export type MessageDestination = z.infer<typeof MessageDestinationSchema>;
export type MessageError = z.infer<typeof MessageErrorSchema>;
export type AtlasMessageEnvelope<T = unknown> =
  & Omit<z.infer<typeof AtlasMessageEnvelopeSchema>, "payload">
  & { payload: T };

// ===== MESSAGE TYPE CONSTANTS =====

export const ATLAS_MESSAGE_TYPES = {
  LIFECYCLE: {
    INIT: "lifecycle.init",
    INITIALIZED: "lifecycle.initialized",
    READY: "lifecycle.ready",
    SHUTDOWN: "lifecycle.shutdown",
    SHUTDOWN_ACK: "lifecycle.shutdown_ack",
    TERMINATE: "lifecycle.terminate",
    TERMINATED: "lifecycle.terminated",
  },
  TASK: {
    EXECUTE: "task.execute",
    RESULT: "task.result",
    ERROR: "task.error",
    PROGRESS: "task.progress",
    CANCEL: "task.cancel",
    TIMEOUT: "task.timeout",
  },
  COMMUNICATION: {
    JOIN_CHANNEL: "communication.join_channel",
    LEAVE_CHANNEL: "communication.leave_channel",
    SET_PORT: "communication.set_port",
    BROADCAST: "communication.broadcast",
  },
  WORKSPACE: {
    SET_WORKSPACE: "workspace.set_workspace",
    PROCESS_SIGNAL: "workspace.process_signal",
    GET_STATUS: "workspace.get_status",
    SESSION_COMPLETE: "workspace.session_complete",
    SESSION_ERROR: "workspace.session_error",
  },
  SESSION: {
    INITIALIZE: "session.initialize",
    EXECUTE: "session.execute",
    INVOKE_AGENT: "session.invoke_agent",
    COMPLETE: "session.complete",
    BROADCAST: "session.broadcast",
  },
  AGENT: {
    EXECUTE: "agent.execute",
    COMPLETE: "agent.complete",
    LOG: "agent.log",
    EXECUTION_COMPLETE: "agent.execution_complete",
  },
  SYSTEM: {
    HEARTBEAT: "system.heartbeat",
    HEALTH_CHECK: "system.health_check",
    METRICS: "system.metrics",
  },
} as const;

export const ATLAS_MESSAGE_DOMAINS = {
  WORKSPACE: {
    LIFECYCLE: [
      "lifecycle.init",
      "lifecycle.initialized",
      "lifecycle.ready",
      "lifecycle.shutdown",
      "lifecycle.terminated",
    ],
    WORKSPACE_OPS: [
      "workspace.set_workspace",
      "workspace.process_signal",
      "workspace.get_status",
    ],
    SESSION_MANAGEMENT: [
      "workspace.session_complete",
      "workspace.session_error",
    ],
    COMMUNICATION: ["communication.join_channel", "communication.set_port"],
  },
  SESSION: {
    LIFECYCLE: [
      "lifecycle.init",
      "lifecycle.initialized",
      "lifecycle.ready",
      "lifecycle.shutdown",
      "lifecycle.terminated",
    ],
    SESSION_OPS: [
      "session.initialize",
      "session.execute",
      "session.invoke_agent",
      "session.complete",
    ],
    TASK_PROCESSING: [
      "task.execute",
      "task.result",
      "task.error",
      "task.progress",
    ],
    COMMUNICATION: [
      "communication.join_channel",
      "communication.set_port",
      "session.broadcast",
    ],
  },
  AGENT: {
    LIFECYCLE: [
      "lifecycle.init",
      "lifecycle.initialized",
      "lifecycle.ready",
      "lifecycle.shutdown",
      "lifecycle.terminated",
    ],
    AGENT_OPS: ["agent.execute", "agent.complete", "agent.execution_complete"],
    TASK_PROCESSING: [
      "task.execute",
      "task.result",
      "task.error",
      "task.progress",
    ],
    LOGGING: ["agent.log"],
    SYSTEM: ["system.heartbeat", "system.health_check", "system.metrics"],
  },
  MANAGER: {
    LIFECYCLE: [
      "lifecycle.init",
      "lifecycle.initialized",
      "lifecycle.shutdown",
      "lifecycle.terminated",
    ],
    TASK_PROCESSING: ["task.execute", "task.result", "task.error"],
    COMMUNICATION: [
      "communication.join_channel",
      "communication.set_port",
      "communication.broadcast",
    ],
    SYSTEM: ["system.heartbeat", "system.health_check", "system.metrics"],
  },
} as const;

// ===== AGENT-SPECIFIC PAYLOAD TYPES =====

export const AgentExecutePayloadSchema = z.object({
  agent_id: z.string(),
  agent_config: z.object({
    type: z.string(),
  }).passthrough(),
  task: z.string(),
  input: z.unknown(),
  environment: z.record(z.string(), z.unknown()),
});

export const AgentExecutionCompletePayloadSchema = z.object({
  agent_id: z.string(),
  result: z.unknown(),
  execution_time_ms: z.number(),
  metadata: z.object({
    tokens_used: z.number().optional(),
    cost: z.number().optional(),
  }).passthrough().optional(),
});

export const AgentLogPayloadSchema = z.object({
  agent_id: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  timestamp: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const AgentProgressPayloadSchema = z.object({
  agent_id: z.string(),
  progress_percentage: z.number().min(0).max(100),
  current_step: z.string(),
  total_steps: z.number().optional(),
  estimated_completion_ms: z.number().optional(),
});

export type AgentExecutePayload = z.infer<typeof AgentExecutePayloadSchema>;
export type AgentExecutionCompletePayload = z.infer<typeof AgentExecutionCompletePayloadSchema>;
export type AgentLogPayload = z.infer<typeof AgentLogPayloadSchema>;
export type AgentProgressPayload = z.infer<typeof AgentProgressPayloadSchema>;

// ===== UTILITY FUNCTIONS =====

export function inferDomainFromWorkerType(workerType: WorkerType): MessageDomain {
  switch (workerType) {
    case "workspace-supervisor":
      return "workspace";
    case "session-supervisor":
      return "session";
    case "agent-execution":
      return "agent";
    case "manager":
      return "manager";
  }
}

export function isValidMessageForDomain(
  messageType: string,
  domain: keyof typeof ATLAS_MESSAGE_DOMAINS,
): boolean {
  const domainEvents = Object.values(ATLAS_MESSAGE_DOMAINS[domain]).flat();
  return domainEvents.includes(messageType);
}

export function filterMessagesForDomain<T>(
  messages: AtlasMessageEnvelope<T>[],
  domain: keyof typeof ATLAS_MESSAGE_DOMAINS,
): AtlasMessageEnvelope<T>[] {
  return messages.filter((msg) =>
    msg.domain === domain.toLowerCase() ||
    isValidMessageForDomain(msg.type, domain)
  );
}

// ===== VALIDATION FUNCTIONS =====

export function validateEnvelope<T>(envelope: unknown): {
  success: true;
  data: AtlasMessageEnvelope<T>;
} | {
  success: false;
  error: z.ZodError;
} {
  const result = AtlasMessageEnvelopeSchema.safeParse(envelope);
  if (result.success) {
    return { success: true, data: result.data as AtlasMessageEnvelope<T> };
  }
  return { success: false, error: result.error };
}

export function validateAgentExecutePayload(payload: unknown): {
  success: true;
  data: AgentExecutePayload;
} | {
  success: false;
  error: z.ZodError;
} {
  const result = AgentExecutePayloadSchema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateAgentExecutionCompletePayload(payload: unknown): {
  success: true;
  data: AgentExecutionCompletePayload;
} | {
  success: false;
  error: z.ZodError;
} {
  const result = AgentExecutionCompletePayloadSchema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

// ===== MESSAGE CREATION OPTIONS =====

export interface MessageCreationOptions {
  correlationId?: string;
  traceHeaders?: Record<string, string>;
  destination?: MessageDestination;
  priority?: MessagePriority;
  timeout?: number;
  acknowledgmentRequired?: boolean;
  channel?: MessageChannel;
  broadcastChannel?: string;
  parentMessageId?: string;
  sequence?: number;
  domain?: MessageDomain;
}

// ===== MESSAGE BUILDERS =====

export function createMessage<T>(
  type: string,
  payload: T,
  source: MessageSource,
  options?: MessageCreationOptions,
): AtlasMessageEnvelope<T> {
  const domain = options?.domain || inferDomainFromWorkerType(source.workerType);

  if (!isValidMessageForDomain(type, domain.toUpperCase() as keyof typeof ATLAS_MESSAGE_DOMAINS)) {
    console.warn(`Message type "${type}" may not be appropriate for domain "${domain}"`);
  }

  const envelope: AtlasMessageEnvelope<T> = {
    id: crypto.randomUUID(),
    type,
    domain,
    source,
    destination: options?.destination,
    timestamp: Date.now(),
    correlationId: options?.correlationId,
    parentMessageId: options?.parentMessageId,
    sequence: options?.sequence,
    channel: options?.channel || "direct",
    broadcastChannel: options?.broadcastChannel,
    traceHeaders: options?.traceHeaders,
    payload,
    priority: options?.priority || "normal",
    timeout: options?.timeout,
    acknowledgmentRequired: options?.acknowledgmentRequired,
  };

  // Validate the created envelope
  const validation = validateEnvelope(envelope);
  if (!validation.success) {
    throw new Error(
      `Invalid envelope created: ${
        (validation as { success: false; error: z.ZodError }).error.message
      }`,
    );
  }

  return envelope;
}

export function createAgentMessage<T>(
  type: string,
  payload: T,
  source: MessageSource,
  options?: MessageCreationOptions,
): AtlasMessageEnvelope<T> {
  return createMessage(type, payload, source, {
    ...options,
    domain: "agent",
  });
}

export function createWorkspaceMessage<T>(
  type: string,
  payload: T,
  source: MessageSource,
  options?: MessageCreationOptions,
): AtlasMessageEnvelope<T> {
  return createMessage(type, payload, source, {
    ...options,
    domain: "workspace",
  });
}

export function createSessionMessage<T>(
  type: string,
  payload: T,
  source: MessageSource,
  options?: MessageCreationOptions,
): AtlasMessageEnvelope<T> {
  return createMessage(type, payload, source, {
    ...options,
    domain: "session",
  });
}

export function createManagerMessage<T>(
  type: string,
  payload: T,
  source: MessageSource,
  options?: MessageCreationOptions,
): AtlasMessageEnvelope<T> {
  return createMessage(type, payload, source, {
    ...options,
    domain: "manager",
  });
}

export function createResponseMessage<T>(
  originalMessage: AtlasMessageEnvelope,
  responseType: string,
  payload: T,
  source: MessageSource,
  options?: Omit<MessageCreationOptions, "correlationId" | "traceHeaders" | "destination">,
): AtlasMessageEnvelope<T> {
  return createMessage(responseType, payload, source, {
    ...options,
    correlationId: originalMessage.correlationId,
    traceHeaders: originalMessage.traceHeaders as Record<string, string>,
    destination: {
      workerId: originalMessage.source.workerId,
      workerType: originalMessage.source.workerType,
      sessionId: originalMessage.source.sessionId,
      workspaceId: originalMessage.source.workspaceId,
    },
    parentMessageId: originalMessage.id,
  });
}

export function createErrorResponse<T = unknown>(
  originalMessage: AtlasMessageEnvelope,
  error: MessageError,
  source: MessageSource,
  payload?: T,
): AtlasMessageEnvelope<T | undefined> {
  const errorResponse = createResponseMessage(
    originalMessage,
    ATLAS_MESSAGE_TYPES.TASK.ERROR,
    payload,
    source,
    { priority: "high" },
  );

  errorResponse.error = error;
  return errorResponse;
}

// ===== AGENT-SPECIFIC BUILDERS =====

export function createAgentExecuteMessage(
  payload: AgentExecutePayload,
  source: MessageSource,
  options?: MessageCreationOptions,
): AtlasMessageEnvelope<AgentExecutePayload> {
  // Validate payload
  const validation = validateAgentExecutePayload(payload);
  if (!validation.success) {
    throw new Error(
      `Invalid agent execute payload: ${
        (validation as { success: false; error: z.ZodError }).error.message
      }`,
    );
  }

  return createAgentMessage(
    ATLAS_MESSAGE_TYPES.AGENT.EXECUTE,
    payload,
    source,
    {
      priority: "normal",
      acknowledgmentRequired: true,
      ...options,
    },
  );
}

export function createAgentExecutionCompleteMessage(
  originalMessage: AtlasMessageEnvelope,
  payload: AgentExecutionCompletePayload,
  source: MessageSource,
): AtlasMessageEnvelope<AgentExecutionCompletePayload> {
  // Validate payload
  const validation = validateAgentExecutionCompletePayload(payload);
  if (!validation.success) {
    throw new Error(
      `Invalid agent execution complete payload: ${
        (validation as { success: false; error: z.ZodError }).error.message
      }`,
    );
  }

  return createResponseMessage(
    originalMessage,
    ATLAS_MESSAGE_TYPES.AGENT.EXECUTION_COMPLETE,
    payload,
    source,
    { priority: "normal" },
  );
}

export function createAgentLogMessage(
  payload: AgentLogPayload,
  source: MessageSource,
  options?: MessageCreationOptions,
): AtlasMessageEnvelope<AgentLogPayload> {
  const validation = AgentLogPayloadSchema.safeParse(payload);
  if (!validation.success) {
    throw new Error(`Invalid agent log payload: ${validation.error.message}`);
  }

  return createAgentMessage(
    ATLAS_MESSAGE_TYPES.AGENT.LOG,
    payload,
    source,
    {
      priority: payload.level === "error" ? "high" : "low",
      channel: "broadcast",
      ...options,
    },
  );
}

export function createAgentProgressMessage(
  payload: AgentProgressPayload,
  source: MessageSource,
  correlationId?: string,
): AtlasMessageEnvelope<AgentProgressPayload> {
  const validation = AgentProgressPayloadSchema.safeParse(payload);
  if (!validation.success) {
    throw new Error(`Invalid agent progress payload: ${validation.error.message}`);
  }

  return createAgentMessage(
    ATLAS_MESSAGE_TYPES.TASK.PROGRESS,
    payload,
    source,
    {
      priority: "low",
      correlationId,
      channel: "broadcast",
    },
  );
}

// ===== UTILITY FUNCTIONS =====

export function generateCorrelationId(): string {
  return crypto.randomUUID();
}

export function extractTraceContext(envelope: AtlasMessageEnvelope): Record<string, string> {
  return {
    ...(envelope.traceHeaders || {}),
    ...(envelope.traceId && { "trace-id": envelope.traceId }),
    ...(envelope.spanId && { "span-id": envelope.spanId }),
    ...(envelope.correlationId && { "correlation-id": envelope.correlationId }),
  };
}

export function createTraceHeaders(
  traceId?: string,
  spanId?: string,
  correlationId?: string,
): Record<string, string> {
  return {
    ...(traceId && { "trace-id": traceId }),
    ...(spanId && { "span-id": spanId }),
    ...(correlationId && { "correlation-id": correlationId }),
  };
}

export function serializeEnvelope(envelope: AtlasMessageEnvelope): string {
  return JSON.stringify(envelope);
}

export function deserializeEnvelope<T = unknown>(data: string): {
  envelope?: AtlasMessageEnvelope<T>;
  error?: string;
} {
  try {
    const parsed = JSON.parse(data);
    const validation = validateEnvelope<T>(parsed);

    if (!validation.success) {
      return {
        error: `Invalid envelope: ${
          (validation as { success: false; error: z.ZodError }).error.message
        }`,
      };
    }

    return { envelope: validation.data };
  } catch (err) {
    return {
      error: `Failed to parse envelope: ${err instanceof Error ? err.message : "Unknown error"}`,
    };
  }
}

export function isMessageTimedOut(envelope: AtlasMessageEnvelope): boolean {
  if (!envelope.timeout) return false;
  return (Date.now() - envelope.timestamp) > envelope.timeout;
}

export function createTimeoutResponse(
  originalMessage: AtlasMessageEnvelope,
  source: MessageSource,
): AtlasMessageEnvelope {
  return createErrorResponse(
    originalMessage,
    {
      code: "TIMEOUT",
      message: `Message timed out after ${originalMessage.timeout}ms`,
      retryable: true,
    },
    source,
  );
}

// ===== TYPE GUARDS =====

export function isAgentExecuteMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<AgentExecutePayload> {
  return envelope.type === ATLAS_MESSAGE_TYPES.AGENT.EXECUTE && envelope.domain === "agent";
}

export function isAgentExecutionCompleteMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<AgentExecutionCompletePayload> {
  return envelope.type === ATLAS_MESSAGE_TYPES.AGENT.EXECUTION_COMPLETE &&
    envelope.domain === "agent";
}

export function isAgentLogMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<AgentLogPayload> {
  return envelope.type === ATLAS_MESSAGE_TYPES.AGENT.LOG && envelope.domain === "agent";
}

export function isAgentProgressMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<AgentProgressPayload> {
  return envelope.type === ATLAS_MESSAGE_TYPES.TASK.PROGRESS && envelope.domain === "agent";
}
