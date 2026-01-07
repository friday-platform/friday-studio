import type { AgentContext } from "@atlas/agent-sdk";
import type { LogContext, Logger } from "@atlas/logger";
import { assertEquals, assertStringIncludes } from "@std/assert";
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

Deno.test("fails fast without ANTHROPIC_API_KEY", async () => {
  // Pass empty env via context - agent should fail because ANTHROPIC_API_KEY is missing
  const result = await claudeCodeAgent.execute("test prompt", createMockContext({ env: {} }));

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.reason, "ANTHROPIC_API_KEY");
  }
});
