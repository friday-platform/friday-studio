import { BaseAgent } from "../../src/core/agents/base-agent.ts";
import type { IWorkspaceAgent } from "../../src/types/core.ts";

export class EchoAgent extends BaseAgent implements IWorkspaceAgent {
  status: string = "idle";
  host: string = "localhost";
  constructor(id?: string) {
    super(id);
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

  override getAgentPrompts(): { system: string; user: string } {
    return {
      system: "You are an echo agent that repeats and elaborates on user messages.",
      user: "",
    };
  }

  controls(): object {
    return {
      canProcessText: true,
      canStream: true,
      isBuiltIn: true,
    };
  }

  async *invokeStream(message: string): AsyncIterableIterator<string> {
    this.log(`Processing message: ${message}`);

    // Add to message history
    this.messages.newMessage(message, "human" as any);

    // Simulate streaming response
    const response =
      `Echo: "${message}"\n\nElaboration: This message contains ${message.length} characters and demonstrates Atlas streaming capabilities. The echo agent successfully processed your input and is now streaming this response back to you in chunks.`;

    // Stream the response
    yield* this.createTextStream(response, 15, 100);

    // Add response to message history
    this.messages.newMessage(response, "agent" as any);

    this.log("Streaming completed");
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
