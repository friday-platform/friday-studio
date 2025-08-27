/**
 * Test utilities that mock Atlas context building without external dependencies.
 */

import type { AgentContext, AgentSessionData, AtlasAgent } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import type { CoALAMemoryManager } from "@atlas/memory";

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
      tools: {}, // Empty tools for test context
      env: envContext,
      session: sessionData,
      stream: overrides?.stream,
      logger: createLogger(),
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
