import type { AgentContext, AgentSessionData, AtlasTools, StreamEmitter } from "@atlas/agent-sdk";

/**
 * Temporary until the entire repo is in Bun.
 */
const testLogger = {
  trace(message: string, context: Record<string, unknown>): void {
    console.log(message, JSON.stringify(context, null, 2));
  },
  debug(message: string, context: Record<string, unknown>): void {
    console.log(message, JSON.stringify(context, null, 2));
  },
  info(message: string, context: Record<string, unknown>): void {
    console.log(message, JSON.stringify(context, null, 2));
  },
  warn(message: string, context: Record<string, unknown>): void {
    console.log(message, JSON.stringify(context, null, 2));
  },
  error(message: string, context: Record<string, unknown>): void {
    console.log(message, JSON.stringify(context, null, 2));
  },
  fatal(message: string, context: Record<string, unknown>): void {
    console.log(message, JSON.stringify(context, null, 2));
  },
  child() {
    return testLogger;
  },
};

/**
 * Minimal context adapter for testing agents without full Atlas infrastructure
 */
export class AgentContextAdapter {
  constructor(
    private tools: AtlasTools = {},
    private env: Record<string, string> = {},
    private memories?: string[],
  ) {}

  createContext(): AgentContext {
    const testSessionId = crypto.randomUUID();
    const session: AgentSessionData = {
      sessionId: testSessionId,
      workspaceId: "eval-workspace",
      userId: "eval-user",
      streamId: `stream-${testSessionId}`,
    };

    // No-op stream
    const stream: StreamEmitter = { emit: () => {}, end: () => {}, error: () => {} };

    return { tools: this.tools, env: this.env, session, stream, logger: testLogger };
  }

  enrichPrompt(prompt: string): string {
    if (!this.memories || this.memories.length === 0) return prompt;
    return `${this.memories.join("\n")}\n\n${prompt}`;
  }
}
