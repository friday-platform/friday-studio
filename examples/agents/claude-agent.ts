import { BaseAgent } from "../../src/core/agents/base-agent.ts";

export class ClaudeAgent extends BaseAgent {
  private model: string;

  constructor(model: string = "claude-3-haiku-20240307", parentScopeId?: string) {
    super(parentScopeId);
    this.model = model;
    this.prompts = this.getAgentPrompts();
  }

  name(): string {
    return `ClaudeAgent-${this.model}`;
  }

  nickname(): string {
    return "Claude";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "anthropic";
  }

  purpose(): string {
    return `AI assistant powered by ${this.model} for software development and automation tasks`;
  }

  getAgentPrompts(): { system: string; user: string } {
    return {
      system: "You are Claude, an AI assistant integrated into the Atlas agent orchestration platform. You help with software development, deployment, and automation tasks. Be concise and practical in your responses.",
      user: ""
    };
  }

  controls(): object {
    return {
      canProcessText: true,
      canStream: true,
      hasLLMAccess: true,
      model: this.model,
      provider: "anthropic"
    };
  }

  async* invokeStream(message: string): AsyncIterableIterator<string> {
    this.log(`Processing with ${this.model}: ${message.slice(0, 50)}...`);
    
    // Add to message history
    this.messages.newMessage(message, "human" as any);

    try {
      // Stream response from Claude
      yield* this.streamLLM(this.model, this.prompts.system, message);
      
      this.log("Claude response streaming completed");
    } catch (error) {
      const errorMsg = `Error calling Claude: ${error instanceof Error ? error.message : String(error)}`;
      this.log(errorMsg);
      yield errorMsg;
    }
  }

  // Override invoke to use streaming and collect response
  override async invoke(message: string): Promise<string> {
    this.status = "processing";
    
    try {
      let fullResponse = "";
      for await (const chunk of this.invokeStream(message)) {
        fullResponse += chunk;
      }
      
      // Add response to message history
      this.messages.newMessage(fullResponse, "agent" as any);
      
      this.status = "idle";
      return fullResponse;
    } catch (error) {
      this.status = "error";
      throw error;
    }
  }
}