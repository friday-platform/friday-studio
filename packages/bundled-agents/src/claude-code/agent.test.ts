import type { AgentContext } from "@atlas/agent-sdk";
import type { LogContext, Logger } from "@atlas/logger";
import { expect, it } from "vitest";
import { claudeCodeAgent } from "./agent.ts";

/**
 * Creates a minimal mock Logger for testing.
 * All methods are no-ops by default.
 */
function createMockLogger(): Logger {
  const noop = () => {};
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: (_context: LogContext) => logger,
  };
  return logger;
}

/**
 * Creates a minimal mock AgentContext for testing.
 * Only provides what's required by the agent handler.
 */
function createMockContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    tools: {},
    session: { sessionId: "test-session-id", workspaceId: "test-workspace-id" },
    env: {},
    stream: undefined,
    logger: createMockLogger(),
    ...overrides,
  };
}

it("fails fast without ANTHROPIC_API_KEY", async () => {
  // Pass empty env via context - agent should fail because ANTHROPIC_API_KEY is missing
  const result = await claudeCodeAgent.execute("test prompt", createMockContext({ env: {} }));

  expect(result.ok).toEqual(false);
  if (!result.ok) {
    expect(result.error.reason).toContain("ANTHROPIC_API_KEY");
  }
});
