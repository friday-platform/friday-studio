import { BaseAgent } from "../../../../src/core/agents/base-agent.ts";
import type { IWorkspaceAgent } from "../../../../src/types/core.ts";

export class TBDAgent extends BaseAgent implements IWorkspaceAgent {
  status: string = "idle";
  host: string = "localhost";
  constructor(id?: string) {
    super(id);

    // Set agent-specific prompts
    this.prompts = {
      system:
        `You are the TBD Agent. You are a helpful assistant that can answer questions and help with tasks.`,
      user: "",
    };
  }

  name(): string {
    return "TBDAgent";
  }

  nickname(): string {
    return "TBD";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "local";
  }

  purpose(): string {
    return "Helpful assistant that can answer questions and help with tasks";
  }

  controls(): object {
    return {
      canProcessText: true,
      canStream: true,
      canAnswerQuestions: true,
      canHelpWithTasks: true,
    };
  }

  override getAgentPrompts(): { system: string; user: string } {
    return {
      system:
        `You are the TBD Agent. You are a helpful assistant that can answer questions and help with tasks.`,
      user: "",
    };
  }

  async *invokeStream(message: string): AsyncIterableIterator<string> {
    this.log(`TBD Agent processing: ${message.slice(0, 50)}...`);

    // Add to message history
    this.messages.newMessage(message, "human" as any);

    // Use the LLM to process the message
    const response = await this.generateLLM(
      "claude-4-sonnet-20250514",
      this.prompts.system,
      message,
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
