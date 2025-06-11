import { BaseAgent } from "../../../../src/core/agents/base-agent.ts";
import { AgentRegistry } from "../../../../src/core/agent-registry.ts";
import type { ITempestMemoryManager, IWorkspaceAgent } from "../../../../src/types/core.ts";

export class EmbellishmentAgent extends BaseAgent implements IWorkspaceAgent {
  status: string = "idle";
  host: string = "localhost";
  constructor(id?: string) {
    super(id);

    // Set agent-specific prompts using BaseAgent utility
    this.setPrompts(`You are the Embellishment Agent in a game of telephone. You embellish and add context.
When you hear a message, add small embellishments like:
- Add time context (yesterday, in the morning)
- Add manner/method (quickly, carefully)
- Add minor details (with a friend, in the rain)
- Slightly change the purpose or add motivation

Keep the core message but make it slightly more detailed.
Always start your response with "I heard that" and then give your version of the message.`);
  }

  name(): string {
    return "EmbellishmentAgent";
  }

  nickname(): string {
    return "Embellisher";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "local";
  }

  purpose(): string {
    return "Adds context and embellishes stories in the telephone game";
  }

  controls(): object {
    return {
      canProcessText: true,
      canStream: true,
      embellishmentTypes: ["temporal", "manner", "details", "motivation"],
    };
  }

  // Uses BaseAgent's standard invoke and invokeStream implementations
}

// No need to register - already registered in AgentRegistry
