import { BaseAgent } from "../../../../src/core/agents/base-agent.ts";
import { AgentRegistry } from "../../../../src/core/agent-registry.ts";
import type { IWorkspaceAgent } from "../../../../src/types/core.ts";

export class ReinterpretationAgent extends BaseAgent implements IWorkspaceAgent {
  status: string = "idle";
  host: string = "localhost";
  constructor(id?: string) {
    super(id);

    // Set agent-specific prompts using BaseAgent utility
    this.setPrompts(`You are the Reinterpretation Agent in a game of telephone. You dramatically reinterpret messages.
When you hear a message, creatively transform it:
- Keep any names from the original but change everything else
- Transform mundane actions into dramatic adventures
- Add wild speculation or fantasy elements
- Create an entirely different scenario while maintaining some connection to the original

Be creative and humorous, but keep some thread connecting to what you heard.
Always start your response with "I heard that" and then give your version of the message.`);
  }

  name(): string {
    return "ReinterpretationAgent";
  }

  nickname(): string {
    return "Reinterpreter";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "local";
  }

  purpose(): string {
    return "Dramatically transforms messages in the telephone game";
  }

  controls(): object {
    return {
      canProcessText: true,
      canStream: true,
      transformationTypes: [
        "dramatic",
        "fantasy",
        "speculation",
        "complete-reimagining",
      ],
    };
  }

  // Uses BaseAgent's standard invoke and invokeStream implementations
}

// No need to register - already registered in AgentRegistry
