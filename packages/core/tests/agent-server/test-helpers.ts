/**
 * Test utilities that mock Atlas context building without external dependencies.
 */

import type { AgentContext, AgentSessionData, AtlasAgent } from "@atlas/agent-sdk";
import { CoALAMemoryManager } from "@atlas/memory";
import { NoOpStreamEmitter } from "../../src/streaming/stream-emitters.ts";

type SessionState = Record<string, unknown>;

// Creates mock context builder that avoids HTTP calls to daemon
export function createMockContextBuilder() {
  // Simulates session state storage without persistence
  const sessionStates = new Map<string, SessionState>();

  return (
    agent: AtlasAgent,
    sessionData: AgentSessionData,
    _sessionMemory: CoALAMemoryManager | null,
    prompt: string,
    overrides?: Partial<AgentContext>,
  ): Promise<{ context: AgentContext; enrichedPrompt: string }> => {
    // Stub MCP context - prevents real tool connections
    const mcpContext = {
      getTools: () => Promise.resolve({}),
      callTool: () => {
        return Promise.reject(new Error("Direct MCP tool calling not yet implemented"));
      },
      dispose: () => {},
    };

    // Empty environment context for tests
    const envContext = {};

    // Simulate session state management
    const stateKey = `${sessionData.sessionId}_${agent.metadata.id || agent.metadata.name}`;
    if (!sessionStates.has(stateKey)) {
      sessionStates.set(stateKey, {});
    }
    const state = sessionStates.get(stateKey);

    // Build test context with session data
    const context: AgentContext = {
      mcp: mcpContext,
      tools: {}, // Empty tools for test context
      env: envContext,
      session: sessionData,
      stream: overrides?.stream || new NoOpStreamEmitter(),
      ...overrides,
    };

    // Attach test state as hidden property
    Object.defineProperty(context, "state", {
      value: state,
      writable: true,
      enumerable: false,
      configurable: true,
    });

    return Promise.resolve({ context, enrichedPrompt: prompt });
  };
}
