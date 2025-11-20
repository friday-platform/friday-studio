/**
 * Core type definitions for the FSM Engine
 */

import type { DocumentScope } from "@atlas/document-store";

// Re-export DocumentScope for convenience
export type { DocumentScope };

export interface JSONSchema {
  type?: "object" | "array" | "string" | "number" | "boolean" | "null";
  properties?: Record<string, unknown>; // Recursive, but typed as unknown for Zod compatibility
  items?: unknown; // Recursive, but typed as unknown for Zod compatibility
  required?: string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | unknown; // Recursive, but typed as unknown for Zod compatibility
  description?: string;
}

export interface FSMDefinition {
  id: string;
  initial: string;
  states: Record<string, StateDefinition>;
  functions?: Record<string, FunctionDefinition>;
  tools?: Record<string, ToolFunctionDefinition>;
  documentTypes?: Record<string, JSONSchema>;
}

export interface StateDefinition {
  documents?: Document[];
  entry?: Action[];
  on?: Record<string, TransitionDefinition | TransitionDefinition[]>;
  type?: "final";
}

export interface Document {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface TransitionDefinition {
  target: string;
  guards?: string[];
  actions?: Action[];
}

export type Action = LLMAction | CodeAction | EmitAction | AgentAction;

export interface LLMAction {
  type: "llm";
  provider: string;
  model: string;
  prompt: string;
  tools?: string[];
  outputTo?: string;
}

export interface CodeAction {
  type: "code";
  function: string;
}

export interface EmitAction {
  type: "emit";
  event: string;
  data?: Record<string, unknown>;
}

export interface AgentAction {
  type: "agent";
  agentId: string;
  outputTo?: string;
}

export interface FunctionDefinition {
  type: "guard" | "action";
  code: string;
}

export interface ToolFunctionDefinition {
  description: string;
  inputSchema: JSONSchema;
  code: string;
}

export interface Context {
  documents: Document[];
  state: string;
  emit?: (signal: Signal) => Promise<void>;
  updateDoc?: (id: string, data: Record<string, unknown>) => void;
  createDoc?: (doc: Document) => void;
}

export type GuardFunction = (context: Context, event: Signal) => boolean;

export type ActionFunction = (
  context: Context,
  event: Signal,
  updateDoc: Context["updateDoc"],
) => void | Promise<void>;

export interface Signal {
  type: string;
  data?: Record<string, unknown>;
}

export interface EmittedEvent {
  event: string;
  data?: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  data?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  context: Context,
) => Promise<unknown> | unknown;

export interface LLMProvider {
  call(params: {
    model: string;
    prompt: string;
    tools?: ToolDefinition[];
    toolExecutors?: Record<string, ToolExecutor>;
  }): Promise<LLMResponse>;
}
