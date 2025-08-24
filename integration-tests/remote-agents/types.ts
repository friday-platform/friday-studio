// ACP Types for Integration Test Server
// Based on ACP v0.2.0 specification

export interface MessagePart {
  content_type: string;
  content: string;
}

export interface Message {
  role: "user" | "assistant" | "system";
  parts: MessagePart[];
}

export interface Agent {
  name: string;
  description: string;
  metadata?: { capabilities?: string[]; version?: string; [key: string]: unknown };
}

export interface AgentsListResponse {
  agents: Agent[];
}

export interface Session {
  id: string;
  history: Message[];
}

export interface ACPError {
  code: "invalid_input" | "not_found" | "server_error" | "unauthorized" | "timeout";
  message: string;
}

export type RunStatus = "created" | "in-progress" | "completed" | "failed" | "cancelled";

export interface Run {
  agent_name: string;
  session_id: string;
  run_id: string;
  status: RunStatus;
  output: Message[];
  created_at: string;
  finished_at?: string;
  error?: ACPError;
}

export interface RunCreateRequest {
  agent_name: string;
  input: Message[];
  session_id?: string;
  mode?: "sync" | "async" | "stream";
}

export interface RunResumeRequest {
  input: Message[];
}

export interface Event {
  type:
    | "run.created"
    | "run.in-progress"
    | "run.completed"
    | "run.failed"
    | "run.cancelled"
    | "message.part"
    | "error";
  run?: Run;
  part?: MessagePart;
  error?: ACPError;
}

export interface RunEventsListResponse {
  events: Event[];
}

// Test-specific interfaces
export interface TestAgent {
  getMetadata(): Agent;
  processMessage(input: Message[]): Promise<Message[]>;
  processMessageStream(input: Message[]): AsyncIterableIterator<MessagePart>;
}
