/**
 * Atlas Message Envelope System
 *
 * Unified message format for all worker communication in Atlas with Zod validation.
 * Provides standardized structure for observability, correlation, and reliability.
 */

import { z } from "zod";

// ===== ZOD SCHEMAS =====

export const WorkerTypeSchema = z.enum([
  "workspace-supervisor",
  "session-supervisor",
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
  id: z.string().uuid(),
  type: z.string(),
  domain: MessageDomainSchema,
  source: MessageSourceSchema,
  destination: MessageDestinationSchema.optional(),
  timestamp: z.number().positive(),
  correlationId: z.string().uuid().optional(),
  parentMessageId: z.string().uuid().optional(),
  sequence: z.number().optional(),
  channel: MessageChannelSchema,
  broadcastChannel: z.string().optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  traceHeaders: z.record(z.string()).optional(),
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
  environment: z.record(z.unknown()),
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
  metadata: z.record(z.unknown()).optional(),
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

// ===== SESSION-SPECIFIC PAYLOAD TYPES =====

export const SessionInitializePayloadSchema = z.object({
  intent: z.object({
    id: z.string(),
    constraints: z.object({
      timeLimit: z.number().optional(),
      costLimit: z.number().optional(),
    }).optional(),
  }).optional(),
  signal: z.record(z.unknown()), // Use unknown for IWorkspaceSignal to avoid deep type checking
  payload: z.record(z.unknown()),
  workspaceId: z.string(),
  agents: z.array(z.object({
    id: z.string(),
    name: z.string(),
    purpose: z.string(),
    capabilities: z.array(z.string()).optional(),
    type: z.enum(["tempest", "llm", "remote"]),
    config: z.record(z.unknown()),
  })),
  jobSpec: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    execution: z.object({
      strategy: z.enum(["sequential", "parallel", "conditional", "staged"]),
      agents: z.array(z.object({
        id: z.string(),
        mode: z.string().optional(),
        prompt: z.string().optional(),
        config: z.record(z.unknown()).optional(),
        input: z.record(z.unknown()).optional(),
      })),
    }),
  }).optional(),
  additionalPrompts: z.object({
    signal: z.string().optional(),
    session: z.string().optional(),
    evaluation: z.string().optional(),
  }).optional(),
});

export const SessionExecutePayloadSchema = z.object({
  sessionId: z.string(),
  executionOptions: z.object({
    maxPhases: z.number().optional(),
    timeout: z.number().optional(),
    strategy: z.enum(["sequential", "parallel", "adaptive"]).optional(),
  }).optional(),
});

export const SessionInvokeAgentPayloadSchema = z.object({
  agentId: z.string(),
  input: z.record(z.unknown()),
  task: z.string().optional(),
  executionContext: z.object({
    phase: z.string().optional(),
    dependencies: z.array(z.string()).optional(),
    inputSource: z.enum(["signal", "previous", "combined", "dependency"]).optional(),
  }).optional(),
});

export const SessionCompletePayloadSchema = z.object({
  sessionId: z.string(),
  status: z.enum(["completed", "failed", "cancelled", "timeout"]),
  results: z.array(z.object({
    phaseId: z.string(),
    phaseName: z.string(),
    results: z.array(z.object({
      agentId: z.string(),
      task: z.string(),
      input: z.record(z.unknown()),
      output: z.record(z.unknown()),
      duration: z.number(),
      timestamp: z.string(),
    })),
  })),
  plan: z.object({
    id: z.string(),
    phases: z.array(z.object({
      id: z.string(),
      name: z.string(),
      executionStrategy: z.enum(["sequential", "parallel"]),
      agents: z.array(z.record(z.unknown())),
    })),
  }).optional(),
  evaluation: z.object({
    isComplete: z.boolean(),
    nextAction: z.enum(["continue", "adapt", "complete"]).optional(),
    feedback: z.string().optional(),
  }).optional(),
  summary: z.string().optional(),
  executionTimeMs: z.number(),
});

export const SessionStatusPayloadSchema = z.object({
  sessionId: z.string(),
  agentCount: z.number(),
  agents: z.array(z.string()),
  executionStatus: z.enum([
    "unknown",
    "initializing",
    "planning",
    "executing",
    "evaluating",
    "completed",
    "failed",
  ]),
  currentPhase: z.string().optional(),
  progress: z.object({
    phasesCompleted: z.number(),
    totalPhases: z.number(),
    agentsExecuted: z.number(),
    totalAgents: z.number(),
  }).optional(),
});

export type SessionInitializePayload = z.infer<typeof SessionInitializePayloadSchema>;
export type SessionExecutePayload = z.infer<typeof SessionExecutePayloadSchema>;
export type SessionInvokeAgentPayload = z.infer<typeof SessionInvokeAgentPayloadSchema>;
export type SessionCompletePayload = z.infer<typeof SessionCompletePayloadSchema>;
export type SessionStatusPayload = z.infer<typeof SessionStatusPayloadSchema>;

// ===== WORKSPACE-SPECIFIC PAYLOAD TYPES =====

export const WorkspaceSetWorkspacePayloadSchema = z.object({
  workspace: z.object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    config: z.record(z.unknown()).optional(),
    signals: z.record(z.unknown()).optional(),
    agents: z.record(z.unknown()).optional(),
    jobs: z.record(z.unknown()).optional(),
  }),
});

export const WorkspaceProcessSignalPayloadSchema = z.object({
  signal: z.object({
    id: z.string(),
    provider: z.object({
      name: z.string(),
      type: z.string().optional(),
    }).optional(),
    payload: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
  }),
  payload: z.record(z.unknown()),
  sessionId: z.string(),
  signalConfig: z.record(z.unknown()).optional(),
  jobs: z.record(z.unknown()).optional(),
});

export const WorkspaceGetStatusPayloadSchema = z.object({
  includeSessionDetails: z.boolean().optional(),
  workspaceId: z.string().optional(),
});

export const WorkspaceStatusPayloadSchema = z.object({
  ready: z.boolean(),
  workspaceId: z.string().optional(),
  sessions: z.number(),
  activeSessions: z.array(z.object({
    sessionId: z.string(),
    status: z.enum(["initializing", "planning", "executing", "evaluating", "completed", "failed"]),
    startTime: z.number(),
    duration: z.number().optional(),
  })).optional(),
  lastSignalProcessed: z.number().optional(),
  memoryUsage: z.object({
    totalMemoryMB: z.number().optional(),
    availableMemoryMB: z.number().optional(),
  }).optional(),
});

export const WorkspaceSessionCompletePayloadSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string().optional(),
  status: z.enum(["completed", "failed", "cancelled", "timeout"]),
  result: z.record(z.unknown()),
  startTime: z.number(),
  endTime: z.number(),
  duration: z.number(),
  signalId: z.string().optional(),
  summary: z.string().optional(),
});

export const WorkspaceSessionErrorPayloadSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    stack: z.string().optional(),
    retryable: z.boolean(),
  }),
  signalId: z.string().optional(),
  context: z.record(z.unknown()).optional(),
});

export type WorkspaceSetWorkspacePayload = z.infer<typeof WorkspaceSetWorkspacePayloadSchema>;
export type WorkspaceProcessSignalPayload = z.infer<typeof WorkspaceProcessSignalPayloadSchema>;
export type WorkspaceGetStatusPayload = z.infer<typeof WorkspaceGetStatusPayloadSchema>;
export type WorkspaceStatusPayload = z.infer<typeof WorkspaceStatusPayloadSchema>;
export type WorkspaceSessionCompletePayload = z.infer<typeof WorkspaceSessionCompletePayloadSchema>;
export type WorkspaceSessionErrorPayload = z.infer<typeof WorkspaceSessionErrorPayloadSchema>;

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

export function validateSessionInitializePayload(payload: unknown): {
  success: true;
  data: SessionInitializePayload;
} | {
  success: false;
  error: z.ZodError;
} {
  const result = SessionInitializePayloadSchema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateSessionExecutePayload(payload: unknown): {
  success: true;
  data: SessionExecutePayload;
} | {
  success: false;
  error: z.ZodError;
} {
  const result = SessionExecutePayloadSchema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateSessionInvokeAgentPayload(payload: unknown): {
  success: true;
  data: SessionInvokeAgentPayload;
} | {
  success: false;
  error: z.ZodError;
} {
  const result = SessionInvokeAgentPayloadSchema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateSessionCompletePayload(payload: unknown): {
  success: true;
  data: SessionCompletePayload;
} | {
  success: false;
  error: z.ZodError;
} {
  const result = SessionCompletePayloadSchema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateSessionStatusPayload(payload: unknown): {
  success: true;
  data: SessionStatusPayload;
} | {
  success: false;
  error: z.ZodError;
} {
  const result = SessionStatusPayloadSchema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

// ===== WORKSPACE PAYLOAD VALIDATION FUNCTIONS =====

export function validateWorkspaceSetWorkspacePayload(payload: unknown): {
  success: true;
  data: WorkspaceSetWorkspacePayload;
} | {
  success: false;
  error: z.ZodError;
} {
  const result = WorkspaceSetWorkspacePayloadSchema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateWorkspaceProcessSignalPayload(payload: unknown): {
  success: true;
  data: WorkspaceProcessSignalPayload;
} | {
  success: false;
  error: z.ZodError;
} {
  const result = WorkspaceProcessSignalPayloadSchema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateWorkspaceGetStatusPayload(payload: unknown): {
  success: true;
  data: WorkspaceGetStatusPayload;
} | {
  success: false;
  error: z.ZodError;
} {
  const result = WorkspaceGetStatusPayloadSchema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateWorkspaceStatusPayload(payload: unknown): {
  success: true;
  data: WorkspaceStatusPayload;
} | {
  success: false;
  error: z.ZodError;
} {
  const result = WorkspaceStatusPayloadSchema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateWorkspaceSessionCompletePayload(payload: unknown): {
  success: true;
  data: WorkspaceSessionCompletePayload;
} | {
  success: false;
  error: z.ZodError;
} {
  const result = WorkspaceSessionCompletePayloadSchema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateWorkspaceSessionErrorPayload(payload: unknown): {
  success: true;
  data: WorkspaceSessionErrorPayload;
} | {
  success: false;
  error: z.ZodError;
} {
  const result = WorkspaceSessionErrorPayloadSchema.safeParse(payload);
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
    throw new Error(`Invalid envelope created: ${validation.error.message}`);
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
    traceHeaders: originalMessage.traceHeaders,
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
    throw new Error(`Invalid agent execute payload: ${validation.error.message}`);
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
    throw new Error(`Invalid agent execution complete payload: ${validation.error.message}`);
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

// ===== SESSION-SPECIFIC BUILDERS =====

export function createSessionInitializeMessage(
  payload: SessionInitializePayload,
  source: MessageSource,
  options?: MessageCreationOptions,
): AtlasMessageEnvelope<SessionInitializePayload> {
  // Validate payload
  const validation = validateSessionInitializePayload(payload);
  if (!validation.success) {
    throw new Error(`Invalid session initialize payload: ${validation.error.message}`);
  }

  return createSessionMessage(
    ATLAS_MESSAGE_TYPES.SESSION.INITIALIZE,
    payload,
    source,
    {
      priority: "normal",
      acknowledgmentRequired: true,
      ...options,
    },
  );
}

export function createSessionExecuteMessage(
  payload: SessionExecutePayload,
  source: MessageSource,
  options?: MessageCreationOptions,
): AtlasMessageEnvelope<SessionExecutePayload> {
  // Validate payload
  const validation = validateSessionExecutePayload(payload);
  if (!validation.success) {
    throw new Error(`Invalid session execute payload: ${validation.error.message}`);
  }

  return createSessionMessage(
    ATLAS_MESSAGE_TYPES.SESSION.EXECUTE,
    payload,
    source,
    {
      priority: "normal",
      acknowledgmentRequired: true,
      ...options,
    },
  );
}

export function createSessionInvokeAgentMessage(
  payload: SessionInvokeAgentPayload,
  source: MessageSource,
  options?: MessageCreationOptions,
): AtlasMessageEnvelope<SessionInvokeAgentPayload> {
  // Validate payload
  const validation = validateSessionInvokeAgentPayload(payload);
  if (!validation.success) {
    throw new Error(`Invalid session invoke agent payload: ${validation.error.message}`);
  }

  return createSessionMessage(
    ATLAS_MESSAGE_TYPES.SESSION.INVOKE_AGENT,
    payload,
    source,
    {
      priority: "normal",
      acknowledgmentRequired: true,
      ...options,
    },
  );
}

export function createSessionCompleteMessage(
  originalMessage: AtlasMessageEnvelope,
  payload: SessionCompletePayload,
  source: MessageSource,
): AtlasMessageEnvelope<SessionCompletePayload> {
  // Validate payload
  const validation = validateSessionCompletePayload(payload);
  if (!validation.success) {
    throw new Error(`Invalid session complete payload: ${validation.error.message}`);
  }

  return createResponseMessage(
    originalMessage,
    ATLAS_MESSAGE_TYPES.SESSION.COMPLETE,
    payload,
    source,
    { priority: "normal" },
  );
}

export function createSessionStatusMessage(
  payload: SessionStatusPayload,
  source: MessageSource,
  options?: MessageCreationOptions,
): AtlasMessageEnvelope<SessionStatusPayload> {
  // Validate payload
  const validation = validateSessionStatusPayload(payload);
  if (!validation.success) {
    throw new Error(`Invalid session status payload: ${validation.error.message}`);
  }

  return createSessionMessage(
    ATLAS_MESSAGE_TYPES.TASK.RESULT, // Use task.result for status responses
    payload,
    source,
    {
      priority: "low",
      ...options,
    },
  );
}

export function createSessionProgressMessage(
  sessionId: string,
  progress: {
    phasesCompleted: number;
    totalPhases: number;
    agentsExecuted: number;
    totalAgents: number;
    currentPhase?: string;
  },
  source: MessageSource,
  correlationId?: string,
): AtlasMessageEnvelope<{
  sessionId: string;
  progress: typeof progress;
  timestamp: number;
}> {
  return createSessionMessage(
    ATLAS_MESSAGE_TYPES.TASK.PROGRESS,
    {
      sessionId,
      progress,
      timestamp: Date.now(),
    },
    source,
    {
      priority: "low",
      correlationId,
      channel: "broadcast",
    },
  );
}

// ===== WORKSPACE-SPECIFIC BUILDERS =====

export function createWorkspaceSetWorkspaceMessage(
  payload: WorkspaceSetWorkspacePayload,
  source: MessageSource,
  options?: MessageCreationOptions,
): AtlasMessageEnvelope<WorkspaceSetWorkspacePayload> {
  // Validate payload
  const validation = validateWorkspaceSetWorkspacePayload(payload);
  if (!validation.success) {
    throw new Error(`Invalid workspace set workspace payload: ${validation.error.message}`);
  }

  return createWorkspaceMessage(
    ATLAS_MESSAGE_TYPES.WORKSPACE.SET_WORKSPACE,
    payload,
    source,
    {
      priority: "normal",
      acknowledgmentRequired: true,
      ...options,
    },
  );
}

export function createWorkspaceProcessSignalMessage(
  payload: WorkspaceProcessSignalPayload,
  source: MessageSource,
  options?: MessageCreationOptions,
): AtlasMessageEnvelope<WorkspaceProcessSignalPayload> {
  // Validate payload
  const validation = validateWorkspaceProcessSignalPayload(payload);
  if (!validation.success) {
    throw new Error(`Invalid workspace process signal payload: ${validation.error.message}`);
  }

  return createWorkspaceMessage(
    ATLAS_MESSAGE_TYPES.WORKSPACE.PROCESS_SIGNAL,
    payload,
    source,
    {
      priority: "normal",
      acknowledgmentRequired: true,
      ...options,
    },
  );
}

export function createWorkspaceGetStatusMessage(
  payload: WorkspaceGetStatusPayload,
  source: MessageSource,
  options?: MessageCreationOptions,
): AtlasMessageEnvelope<WorkspaceGetStatusPayload> {
  // Validate payload
  const validation = validateWorkspaceGetStatusPayload(payload);
  if (!validation.success) {
    throw new Error(`Invalid workspace get status payload: ${validation.error.message}`);
  }

  return createWorkspaceMessage(
    ATLAS_MESSAGE_TYPES.WORKSPACE.GET_STATUS,
    payload,
    source,
    {
      priority: "low",
      acknowledgmentRequired: true,
      ...options,
    },
  );
}

export function createWorkspaceStatusMessage(
  payload: WorkspaceStatusPayload,
  source: MessageSource,
  options?: MessageCreationOptions,
): AtlasMessageEnvelope<WorkspaceStatusPayload> {
  // Validate payload
  const validation = validateWorkspaceStatusPayload(payload);
  if (!validation.success) {
    throw new Error(`Invalid workspace status payload: ${validation.error.message}`);
  }

  return createWorkspaceMessage(
    ATLAS_MESSAGE_TYPES.TASK.RESULT, // Use task.result for status responses
    payload,
    source,
    {
      priority: "low",
      ...options,
    },
  );
}

export function createWorkspaceSessionCompleteMessage(
  originalMessage: AtlasMessageEnvelope,
  payload: WorkspaceSessionCompletePayload,
  source: MessageSource,
): AtlasMessageEnvelope<WorkspaceSessionCompletePayload> {
  // Validate payload
  const validation = validateWorkspaceSessionCompletePayload(payload);
  if (!validation.success) {
    throw new Error(`Invalid workspace session complete payload: ${validation.error.message}`);
  }

  return createResponseMessage(
    originalMessage,
    ATLAS_MESSAGE_TYPES.WORKSPACE.SESSION_COMPLETE,
    payload,
    source,
    { priority: "normal" },
  );
}

export function createWorkspaceSessionErrorMessage(
  originalMessage: AtlasMessageEnvelope,
  payload: WorkspaceSessionErrorPayload,
  source: MessageSource,
): AtlasMessageEnvelope<WorkspaceSessionErrorPayload> {
  // Validate payload
  const validation = validateWorkspaceSessionErrorPayload(payload);
  if (!validation.success) {
    throw new Error(`Invalid workspace session error payload: ${validation.error.message}`);
  }

  return createResponseMessage(
    originalMessage,
    ATLAS_MESSAGE_TYPES.WORKSPACE.SESSION_ERROR,
    payload,
    source,
    { priority: "high" },
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
      return { error: `Invalid envelope: ${validation.error.message}` };
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

export function isSessionInitializeMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<SessionInitializePayload> {
  return envelope.type === ATLAS_MESSAGE_TYPES.SESSION.INITIALIZE && envelope.domain === "session";
}

export function isSessionExecuteMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<SessionExecutePayload> {
  return envelope.type === ATLAS_MESSAGE_TYPES.SESSION.EXECUTE && envelope.domain === "session";
}

export function isSessionInvokeAgentMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<SessionInvokeAgentPayload> {
  return envelope.type === ATLAS_MESSAGE_TYPES.SESSION.INVOKE_AGENT &&
    envelope.domain === "session";
}

export function isSessionCompleteMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<SessionCompletePayload> {
  return envelope.type === ATLAS_MESSAGE_TYPES.SESSION.COMPLETE && envelope.domain === "session";
}

export function isSessionStatusMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<SessionStatusPayload> {
  return envelope.type === ATLAS_MESSAGE_TYPES.TASK.RESULT && envelope.domain === "session";
}

export function isSessionProgressMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<{
  sessionId: string;
  progress: {
    phasesCompleted: number;
    totalPhases: number;
    agentsExecuted: number;
    totalAgents: number;
    currentPhase?: string;
  };
  timestamp: number;
}> {
  return envelope.type === ATLAS_MESSAGE_TYPES.TASK.PROGRESS && envelope.domain === "session";
}

// ===== WORKSPACE MESSAGE TYPE GUARDS =====

export function isWorkspaceSetWorkspaceMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<WorkspaceSetWorkspacePayload> {
  return envelope.type === ATLAS_MESSAGE_TYPES.WORKSPACE.SET_WORKSPACE && envelope.domain === "workspace";
}

export function isWorkspaceProcessSignalMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<WorkspaceProcessSignalPayload> {
  return envelope.type === ATLAS_MESSAGE_TYPES.WORKSPACE.PROCESS_SIGNAL && envelope.domain === "workspace";
}

export function isWorkspaceGetStatusMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<WorkspaceGetStatusPayload> {
  return envelope.type === ATLAS_MESSAGE_TYPES.WORKSPACE.GET_STATUS && envelope.domain === "workspace";
}

export function isWorkspaceStatusMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<WorkspaceStatusPayload> {
  return envelope.type === ATLAS_MESSAGE_TYPES.TASK.RESULT && envelope.domain === "workspace";
}

export function isWorkspaceSessionCompleteMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<WorkspaceSessionCompletePayload> {
  return envelope.type === ATLAS_MESSAGE_TYPES.WORKSPACE.SESSION_COMPLETE && envelope.domain === "workspace";
}

export function isWorkspaceSessionErrorMessage(
  envelope: AtlasMessageEnvelope,
): envelope is AtlasMessageEnvelope<WorkspaceSessionErrorPayload> {
  return envelope.type === ATLAS_MESSAGE_TYPES.WORKSPACE.SESSION_ERROR && envelope.domain === "workspace";
}
