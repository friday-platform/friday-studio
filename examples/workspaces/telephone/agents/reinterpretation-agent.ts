import { BaseAgent } from "../../../../src/core/agents/base-agent.ts";
import { AgentRegistry } from "../../../../src/core/agent-registry.ts";
import type { IWorkspaceAgent } from "../../../../src/types/core.ts";

export class ReinterpretationAgent extends BaseAgent implements IWorkspaceAgent {
  status: string = "idle";
  host: string = "localhost";
  constructor(id?: string) {
    super(id);
    
    // Set agent-specific prompts
    this.prompts = {
      system: `You are the Reinterpretation Agent in a game of telephone. You dramatically reinterpret messages.
When you hear a message, creatively transform it:
- Keep any names from the original but change everything else
- Transform mundane actions into dramatic adventures
- Add wild speculation or fantasy elements
- Create an entirely different scenario while maintaining some connection to the original

Be creative and humorous, but keep some thread connecting to what you heard.
Always start your response with "I heard that" and then give your version of the message.`,
      user: ""
    };
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
      transformationTypes: ["dramatic", "fantasy", "speculation", "complete-reimagining"]
    };
  }

  override getAgentPrompts(): { system: string; user: string } {
    return {
      system: `You are the Reinterpretation Agent in a game of telephone. You dramatically reinterpret messages.
When you hear a message, creatively transform it:
- Keep any names from the original but change everything else
- Transform mundane actions into dramatic adventures
- Add wild speculation or fantasy elements
- Create an entirely different scenario while maintaining some connection to the original

Be creative and humorous, but keep some thread connecting to what you heard.
Always start your response with "I heard that" and then give your version of the message.`,
      user: ""
    };
  }

  async* invokeStream(message: string): AsyncIterableIterator<string> {
    this.log(`Reinterpretation Agent processing: ${message.slice(0, 50)}...`);
    
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