/**
 * Test helpers for creating properly typed test data
 */

import type { ToolCall, ToolResult } from "@atlas/agent-sdk";

/**
 * Create a test ToolCall with proper AI SDK structure
 */
export function createTestToolCall(params: {
  toolCallId: string;
  toolName: string;
  input: unknown;
}): ToolCall {
  return { type: "tool-call", ...params };
}

/**
 * Create a test ToolResult with proper AI SDK structure
 *
 * Note: AI SDK ToolResult uses 'input' and 'output' fields, not 'result'.
 * We accept 'result' for convenience and map it to 'output'.
 */
export function createTestToolResult(params: {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  result: unknown;
}): ToolResult {
  return {
    type: "tool-result",
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    input: params.input ?? {},
    output: params.result,
  };
}
