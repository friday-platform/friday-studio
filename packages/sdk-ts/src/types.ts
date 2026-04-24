/**
 * Type definitions for the Atlas TypeScript Agent SDK.
 * Mirrors the Python SDK's AgentContext interface.
 * @module
 */

export interface SessionData {
  id: string;
  workspaceId: string;
  userId: string;
  datetime: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface AgentContext {
  /** Environment variables passed from the workspace configuration. */
  env: Record<string, string>;
  /** Agent configuration from workspace.yml. */
  config: Record<string, unknown>;
  /** Session metadata (id, workspaceId, userId, datetime). */
  session: SessionData;
  llm: {
    /**
     * Generate a response from an LLM. Request format mirrors the WIT LLM interface.
     * Returns the full response object from the LLM provider.
     */
    generate(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  http: {
    /**
     * Execute an HTTP request. Request format: `{ url, method, headers?, body? }`.
     * Returns the response object.
     */
    fetch(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  tools: {
    /** Call a tool by name with the given arguments. */
    call(name: string, args: Record<string, unknown>): Promise<unknown>;
    /** List available tools from MCP servers. */
    list(): Promise<ToolDefinition[]>;
  };
  stream: {
    /** Publish a streaming event to the session event stream. */
    emit(eventType: string, payload: unknown): void;
  };
}

export interface AgentMeta {
  id: string;
  version: string;
  description?: string;
}

export interface OkResult {
  tag: "ok";
  val: string;
}

export interface ErrResult {
  tag: "err";
  val: string;
}

export type AgentResult = OkResult | ErrResult;

export type AgentHandler = (
  prompt: string,
  ctx: AgentContext,
) => Promise<AgentResult> | AgentResult;
