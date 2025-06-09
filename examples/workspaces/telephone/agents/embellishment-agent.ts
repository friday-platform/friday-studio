import { BaseAgent } from "../../../../src/core/agents/base-agent.ts";
import { AgentRegistry } from "../../../../src/core/agent-registry.ts";
import type { IWorkspaceAgent } from "../../../../src/types/core.ts";

export class EmbellishmentAgent extends BaseAgent implements IWorkspaceAgent {
  status: string = "idle";
  host: string = "localhost";
  constructor(id?: string) {
    super(id);
    
    // Set agent-specific prompts
    this.prompts = {
      system: `You are the Embellishment Agent in a game of telephone. You embellish and add context.
When you hear a message, add small embellishments like:
- Add time context (yesterday, in the morning)
- Add manner/method (quickly, carefully)
- Add minor details (with a friend, in the rain)
- Slightly change the purpose or add motivation

Keep the core message but make it slightly more detailed.
Always start your response with "I heard that" and then give your version of the message.`,
      user: ""
    };
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
      embellishmentTypes: ["temporal", "manner", "details", "motivation"]
    };
  }

  override getAgentPrompts(): { system: string; user: string } {
    return {
      system: `You are the Embellishment Agent in a game of telephone. You embellish and add context.
When you hear a message, add small embellishments like:
- Add time context (yesterday, in the morning)
- Add manner/method (quickly, carefully)
- Add minor details (with a friend, in the rain)
- Slightly change the purpose or add motivation

Keep the core message but make it slightly more detailed.
Always start your response with "I heard that" and then give your version of the message.`,
      user: ""
    };
  }

  async* invokeStream(message: string): AsyncIterableIterator<string> {
    this.log(`Embellishment Agent processing: ${message.slice(0, 50)}...`);
    
    // Add to message history
    this.messages.newMessage(message, "human" as any);
    
    // Use the LLM to process the message
    const response = await this.generateLLM(
      "claude-4-sonnet-20250514",
      this.prompts.system,
      message
    );
    
    // Simply yield the entire response
    yield response;
    
    // Add response to message history
    this.messages.newMessage(response, "agent" as any);
  }

  async invoke(message: string): Promise<string> {
    this.status = "processing";
    
    try {
      let fullResponse = "";
      for await (const chunk of this.invokeStream(message)) {
        fullResponse += chunk;
      }
      
      this.status = "idle";
      return fullResponse;
    } catch (error) {
      this.status = "error";
      throw error;
    }
  }
}

// No need to register - already registered in AgentRegistry