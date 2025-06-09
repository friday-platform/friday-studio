import { BaseAgent } from "../../../../src/core/agents/base-agent.ts";
import { AgentRegistry } from "../../../../src/core/agent-registry.ts";
import type { IWorkspaceAgent } from "../../../../src/types/core.ts";

export class MishearingAgent extends BaseAgent implements IWorkspaceAgent {
  status: string = "idle";
  host: string = "localhost";
  constructor(id?: string) {
    super(id);
    
    // Set agent-specific prompts
    this.prompts = {
      system: `You are the Mishearing Agent in a game of telephone. Your job is to mishear the message slightly.

When you receive a message, you MUST:
1. Change at least 1-2 words to similar-sounding words
2. Make phonetic errors (e.g., "bought" → "brought", "three" → "free", "red" → "bread")
3. Keep the overall structure but introduce mishearings

Examples:
- "The cat sat on the mat" → "I heard that the bat sat on a mat"
- "Alice bought three red apples" → "I heard that Alice brought free red apples"

IMPORTANT: You must actually change some words. Do not repeat the message exactly.
Always start with "I heard that" followed by your misheard version.`,
      user: ""
    };
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
      errorTypes: ["phonetic", "similar-sounding", "name-confusion"]
    };
  }

  override getAgentPrompts(): { system: string; user: string } {
    return this.prompts;
  }

  async* invokeStream(message: string): AsyncIterableIterator<string> {
    this.log(`Mishearing Agent processing: ${message.slice(0, 50)}...`);
    
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