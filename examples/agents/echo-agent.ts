import { BaseAgent } from "../../src/core/agents/base-agent.ts";

export class EchoAgent extends BaseAgent {
  constructor(parentScopeId?: string) {
    super(parentScopeId);
    this.prompts = this.getAgentPrompts();
  }

  name(): string {
    return "EchoAgent";
  }

  nickname(): string {
    return "Echo";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "atlas-builtin";
  }

  purpose(): string {
    return "Echoes messages back with elaboration for testing streaming functionality";
  }

  getAgentPrompts(): { system: string; user: string } {
    return {
      system: "You are an echo agent that repeats and elaborates on user messages.",
      user: ""
    };
  }

  controls(): object {
    return {
      canProcessText: true,
      canStream: true,
      isBuiltIn: true
    };
  }

  async* invokeStream(message: string): AsyncIterableIterator<string> {
    this.log(`Processing message: ${message}`);
    
    // Add to message history
    this.messages.newMessage(message, "human" as any);

    // Simulate streaming response
    const response = `Echo: "${message}"\n\nElaboration: This message contains ${message.length} characters and demonstrates Atlas streaming capabilities. The echo agent successfully processed your input and is now streaming this response back to you in chunks.`;
    
    // Stream the response
    yield* this.createTextStream(response, 15, 100);
    
    // Add response to message history
    this.messages.newMessage(response, "agent" as any);
    
    this.log("Streaming completed");
  }
}