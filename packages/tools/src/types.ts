import type { Tool } from "ai";

export type Tools = Record<string, Tool>;

/**
 * Agent context information passed to tools during execution
 * This separates agent runtime context from LLM parameters
 *
 * Context values can be:
 * - undefined: context not provided (registry should use standard tool)
 * - null: context explicitly set to null (registry should use standard tool)
 * - string: context provided (registry should inject context and remove parameter)
 */
export interface AgentContext {
  streamId?: string | null;
  userId?: string | null;
  conversationId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Context injection configuration for tools
 * Maps tool names to their context requirements
 */
export interface ToolContextRequirements {
  [toolName: string]: {
    /** Context fields this tool can use (when provided, removes from parameters) */
    injectableFields: (keyof AgentContext)[];
    /** Whether this tool supports context injection */
    supportsContextInjection: boolean;
  };
}

/**
 * Result of context injection transformation
 */
export interface ContextInjectionResult {
  /** The transformed tool (may be same as original if no context) */
  tool: Tool;
  /** Whether context was actually injected */
  contextInjected: boolean;
  /** Which context fields were injected */
  injectedFields: string[];
}

/**
 * Extended tool execution options with agent context
 */
export interface ToolExecutionOptionsWithContext {
  toolCallId: string;
  messages: Array<{ role: string; content: string }>;
  agentContext?: AgentContext;
}
