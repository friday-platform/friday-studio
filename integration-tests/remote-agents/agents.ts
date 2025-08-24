// Test Agents for ACP Integration Tests

import type { Agent, Message, MessagePart, TestAgent } from "./types.ts";

class EchoAgent implements TestAgent {
  getMetadata(): Agent {
    return {
      name: "echo",
      description: "Simple echo agent that returns input messages",
      metadata: { capabilities: ["text"], version: "1.0.0" },
    };
  }

  processMessage(input: Message[]): Promise<Message[]> {
    // Simple echo - return the input as assistant response
    return Promise.resolve(
      input.map((msg) => ({
        role: "assistant" as const,
        parts: msg.parts.map((part) => ({
          content_type: part.content_type,
          content: `Echo: ${part.content}`,
        })),
      })),
    );
  }

  async *processMessageStream(input: Message[]): AsyncIterableIterator<MessagePart> {
    for (const message of input) {
      for (const part of message.parts) {
        const response = `Echo: ${part.content}`;

        // Stream as: start -> content -> end
        yield { content_type: "text/plain", content: "[START]" };

        yield { content_type: part.content_type, content: response };

        yield { content_type: "text/plain", content: "[END]" };
      }
    }
  }
}

class ErrorAgent implements TestAgent {
  getMetadata(): Agent {
    return {
      name: "error",
      description: "Agent that always throws errors for testing error handling",
      metadata: { capabilities: ["error"], version: "1.0.0" },
    };
  }

  processMessage(_input: Message[]): Promise<Message[]> {
    return Promise.reject(new Error("Simulated agent processing error"));
  }

  async *processMessageStream(_input: Message[]): AsyncIterableIterator<MessagePart> {
    yield { content_type: "text/plain", content: "[ERROR]" };
    throw new Error("Simulated streaming error");
  }
}

class SlowAgent implements TestAgent {
  getMetadata(): Agent {
    return {
      name: "slow",
      description: "Agent that introduces delays for timeout testing",
      metadata: { capabilities: ["text", "timeout"], version: "1.0.0" },
    };
  }

  async processMessage(input: Message[]): Promise<Message[]> {
    // Wait 2 seconds to test timeout handling
    await new Promise((resolve) => setTimeout(resolve, 2000));

    return input.map((msg) => ({
      role: "assistant" as const,
      parts: msg.parts.map((part) => ({
        content_type: part.content_type,
        content: `Slow response: ${part.content}`,
      })),
    }));
  }

  async *processMessageStream(input: Message[]): AsyncIterableIterator<MessagePart> {
    for (const message of input) {
      for (const part of message.parts) {
        // Small delay between each part
        await new Promise((resolve) => setTimeout(resolve, 500));

        yield { content_type: part.content_type, content: `Slow: ${part.content}` };
      }
    }
  }
}

// Agent registry
const agents = new Map<string, TestAgent>([
  ["echo", new EchoAgent()],
  ["error", new ErrorAgent()],
  ["slow", new SlowAgent()],
]);

export function listAgents(): Agent[] {
  return Array.from(agents.values()).map((agent) => agent.getMetadata());
}

export function getAgent(name: string): TestAgent | undefined {
  return agents.get(name);
}
