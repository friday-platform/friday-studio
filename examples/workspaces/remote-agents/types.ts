// ACP v0.2.0 Type Definitions
// Based on the official OpenAPI specification

export type RunStatus = 
  | "created"
  | "in-progress" 
  | "awaiting"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

export type RunMode = "sync" | "async" | "stream";

export interface MessagePart {
  name?: string;
  content_type: string;
  content?: string;
  content_encoding?: "plain" | "base64";
  content_url?: string;
}

export interface Message {
  parts: MessagePart[];
  created_at?: string;
  completed_at?: string;
  role: string; // "user", "agent", or "agent/{agent_name}"
}

export interface Agent {
  name: string;
  description: string;
  metadata?: Metadata;
  status?: Status;
}

export interface Status {
  avg_run_tokens?: number;
  avg_run_time_seconds?: number;
  success_rate?: number;
}

export interface Metadata {
  annotations?: Record<string, unknown>;
  documentation?: string;
  license?: string;
  programming_language?: string;
  natural_languages?: string[];
  framework?: string;
  capabilities?: Array<{
    name: string;
    description: string;
  }>;
  domains?: string[];
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  author?: Person;
  contributors?: Person[];
  links?: Link[];
}

export interface Person {
  name?: string;
  email?: string;
  url?: string;
}

export interface Link {
  type: string;
  url: string;
}

export interface Run {
  agent_name: string;
  session_id?: string;
  run_id: string;
  status: RunStatus;
  await_request?: unknown;
  output: Message[];
  error?: ACPError;
  created_at: string;
  finished_at?: string;
}

export interface RunCreateRequest {
  agent_name: string;
  session_id?: string;
  session?: Session;
  input: Message[];
  mode?: RunMode;
}

export interface RunResumeRequest {
  run_id: string;
  await_resume: unknown;
  mode?: RunMode;
}

export interface Session {
  id: string;
  history: string[];
  state?: string;
}

export interface ACPError {
  code: "server_error" | "invalid_input" | "not_found";
  message: string;
}

export interface AgentsListResponse {
  agents: Agent[];
}

export interface RunEventsListResponse {
  events: Event[];
}

// Event types for streaming
export type Event = 
  | MessageCreatedEvent
  | MessagePartEvent
  | MessageCompletedEvent
  | GenericEvent
  | RunCreatedEvent
  | RunInProgressEvent
  | RunAwaitingEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | ErrorEvent;

export interface MessageCreatedEvent {
  type: "message.created";
  message: Message;
}

export interface MessagePartEvent {
  type: "message.part";
  part: MessagePart;
}

export interface MessageCompletedEvent {
  type: "message.completed";
  message: Message;
}

export interface GenericEvent {
  type: "generic";
  generic: Record<string, unknown>;
}

export interface RunCreatedEvent {
  type: "run.created";
  run: Run;
}

export interface RunInProgressEvent {
  type: "run.in-progress";
  run: Run;
}

export interface RunAwaitingEvent {
  type: "run.awaiting";
  run: Run;
}

export interface RunCompletedEvent {
  type: "run.completed";
  run: Run;
}

export interface RunFailedEvent {
  type: "run.failed";
  run: Run;
}

export interface RunCancelledEvent {
  type: "run.cancelled";
  run: Run;
}

export interface ErrorEvent {
  type: "error";
  error: ACPError;
}