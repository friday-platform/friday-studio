import { BaseAgent } from "../../src/core/agents/base-agent.ts";
import type { IWorkspaceAgent } from "../../src/types/core.ts";

export interface LLMConfig {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export class LLMAgent extends BaseAgent implements IWorkspaceAgent {
  private config: LLMConfig;
  status: string = "idle";
  host: string = "localhost";

  constructor(config: LLMConfig, id?: string) {
    super(id);
    this.config = config;
    this.prompts = this.getAgentPrompts();
  }

  name(): string {
    return `LLMAgent-${this.config.model}`;
  }

  nickname(): string {
    return this.config.model.split("/").pop() || "LLM";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return this.config.model.includes("gpt")
      ? "openai"
      : this.config.model.includes("claude")
      ? "anthropic"
      : this.config.model.includes("gemini")
      ? "google"
      : "unknown";
  }

  purpose(): string {
    return `AI assistant powered by ${this.config.model} for general task processing`;
  }

  override getAgentPrompts(): { system: string; user: string } {
    return {
      system:
        "You are a helpful AI assistant integrated into the Atlas agent orchestration platform.",
      user: "",
    };
  }

  controls(): object {
    return {
      canProcessText: true,
      canStream: true,
      hasLLMAccess: true,
      model: this.config.model,
      temperature: this.config.temperature || 0.7,
    };
  }

  override async *invokeStream(message: string): AsyncIterableIterator<string> {
    this.log(
      `Processing with ${this.config.model}: ${message.slice(0, 50)}...`,
    );

    // Add to message history
    this.messages.newMessage(message, "human" as any);

    try {
      // For now, simulate LLM streaming with a mock response
      // TODO: Replace with actual LLM API calls
      const mockResponse = await this.generateMockLLMResponse(message);

      // Stream the response
      yield* this.createTextStream(mockResponse, 20, 80);

      // Add response to message history
      this.messages.newMessage(mockResponse, "agent" as any);

      this.log("LLM response streaming completed");
    } catch (error) {
      const errorMsg = `Error calling ${this.config.model}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.log(errorMsg);
      yield errorMsg;
    }
  }

  private async generateMockLLMResponse(message: string): Promise<string> {
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Mock response based on message content
    if (message.toLowerCase().includes("code")) {
      return `I can help you with code! Here's a response about coding using ${this.config.model}:\n\n\`\`\`typescript\n// Example code\nfunction processMessage(msg: string) {\n  return msg.toUpperCase();\n}\n\`\`\`\n\nThis demonstrates how I can generate code responses through the Atlas platform.`;
    } else if (message.toLowerCase().includes("deploy")) {
      return `For deployment tasks using ${this.config.model}, I recommend:\n\n1. Run tests first\n2. Build the application\n3. Deploy to staging\n4. Validate deployment\n5. Deploy to production\n\nI can coordinate with other Atlas agents to execute these steps automatically.`;
    } else {
      return `Hello! I'm an LLM agent running ${this.config.model} in the Atlas platform. You said: "${message}"\n\nI'm designed to work with other agents to handle complex software delivery tasks. What would you like me to help with?`;
    }
  }

  // Method to actually call LLM APIs (to be implemented)
  private async callLLMAPI(
    message: string,
  ): Promise<AsyncIterableIterator<string>> {
    // TODO: Implement actual API calls based on provider
    switch (this.provider()) {
      case "openai":
        return this.callOpenAI(message);
      case "anthropic":
        return this.callAnthropic(message);
      case "google":
        return this.callGemini(message);
      default:
        throw new Error(`Unsupported LLM provider: ${this.provider()}`);
    }
  }

  private async callOpenAI(
    message: string,
  ): Promise<AsyncIterableIterator<string>> {
    // TODO: Implement OpenAI streaming API call
    throw new Error("OpenAI integration not implemented yet");
  }

  private async callAnthropic(
    message: string,
  ): Promise<AsyncIterableIterator<string>> {
    // TODO: Implement Anthropic streaming API call
    throw new Error("Anthropic integration not implemented yet");
  }

  private async callGemini(
    message: string,
  ): Promise<AsyncIterableIterator<string>> {
    // TODO: Implement Gemini streaming API call
    throw new Error("Gemini integration not implemented yet");
  }

  override async invoke(message: string): Promise<string> {
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

  private async *createTextStream(
    text: string,
    chunkSize: number,
    delayMs: number,
  ): AsyncIterableIterator<string> {
    for (let i = 0; i < text.length; i += chunkSize) {
      yield text.slice(i, i + chunkSize);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
