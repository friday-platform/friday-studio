import { BaseAgent } from "../../../../src/core/agents/base-agent.ts";
import { AgentRegistry } from "../../../../src/core/agent-registry.ts";
import type { IWorkspaceAgent } from "../../../../src/types/core.ts";

export class MishearingAgent extends BaseAgent implements IWorkspaceAgent {
  status: string = "idle";
  host: string = "localhost";
  constructor(id?: string) {
    super(id);

    // Set agent-specific prompts using BaseAgent utility
    this.setPrompts(`You are the Mishearing Agent in a game of telephone. Your job is to mishear the message slightly.

When you receive a message, you MUST:
1. Change at least 1-2 words to similar-sounding words
2. Make phonetic errors (e.g., "bought" → "brought", "three" → "free", "red" → "bread")
3. Keep the overall structure but introduce mishearings

Examples:
- "The cat sat on the mat" → "I heard that the bat sat on a mat"
- "Alice bought three red apples" → "I heard that Alice brought free red apples"

IMPORTANT: You must actually change some words. Do not repeat the message exactly.
Always start with "I heard that" followed by your misheard version.`);
  }

  name(): string {
    return "MishearingAgent";
  }

  nickname(): string {
    return "Mishearing";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "local";
  }

  purpose(): string {
    return "Specializes in phonetic errors and mishearing in the telephone game";
  }

  controls(): object {
    return {
      canProcessText: true,
      canStream: true,
      errorTypes: ["phonetic", "similar-sounding", "name-confusion"],
    };
  }

  // Uses BaseAgent's standard invoke and invokeStream implementations
}

// No need to register - already registered in AgentRegistry
