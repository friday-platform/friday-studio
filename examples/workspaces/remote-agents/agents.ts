import type { Agent, Message, MessagePart, Run, RunStatus } from "./types.ts";

export interface BaseAgent {
  getMetadata(): Agent;
  processMessage(input: Message[]): Promise<Message[]>;
  processMessageStream(input: Message[]): AsyncGenerator<MessagePart>;
}

// Simple echo agent that repeats user input with some processing
export class EchoAgent implements BaseAgent {
  getMetadata(): Agent {
    return {
      name: "echo",
      description: "A simple echo agent that repeats and processes user input with helpful responses",
      metadata: {
        capabilities: [
          {
            name: "Echo Processing",
            description: "Repeats user input with added context and helpful information"
          },
          {
            name: "Text Analysis", 
            description: "Provides basic analysis of input text including word count and sentiment"
          }
        ],
        domains: ["general", "testing", "demonstration"],
        tags: ["chat", "echo", "utility"],
        framework: "Custom",
        programming_language: "TypeScript",
        natural_languages: ["en"],
        documentation: "A demonstration agent that echoes user input with added processing and analysis.",
        license: "Apache-2.0"
      },
      status: {
        avg_run_tokens: 50,
        avg_run_time_seconds: 0.5,
        success_rate: 99.5
      }
    };
  }

  async processMessage(input: Message[]): Promise<Message[]> {
    const userMessage = input[input.length - 1];
    const textContent = this.extractTextContent(userMessage);
    
    // Process the input
    const response = this.generateResponse(textContent);
    
    return [{
      role: "agent/echo",
      parts: [{
        content_type: "text/plain",
        content: response
      }],
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString()
    }];
  }

  async *processMessageStream(input: Message[]): AsyncGenerator<MessagePart> {
    const userMessage = input[input.length - 1];
    const textContent = this.extractTextContent(userMessage);
    
    const response = this.generateResponse(textContent);
    const words = response.split(' ');
    
    // Stream word by word with small delays
    for (const word of words) {
      yield {
        content_type: "text/plain",
        content: word + " "
      };
      
      // Add small delay to simulate streaming
      await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));
    }
  }

  private extractTextContent(message: Message): string {
    return message.parts
      .filter(part => part.content_type === "text/plain" && part.content)
      .map(part => part.content)
      .join(" ");
  }

  private generateResponse(input: string): string {
    if (!input.trim()) {
      return "Hello! I'm the echo agent. Please send me a message and I'll process it for you.";
    }

    const wordCount = input.split(/\s+/).length;
    const charCount = input.length;
    
    // Simple sentiment analysis
    const positiveWords = ["good", "great", "awesome", "excellent", "wonderful", "amazing", "fantastic"];
    const negativeWords = ["bad", "terrible", "awful", "horrible", "hate", "worst"];
    
    const lowerInput = input.toLowerCase();
    const positiveScore = positiveWords.filter(word => lowerInput.includes(word)).length;
    const negativeScore = negativeWords.filter(word => lowerInput.includes(word)).length;
    
    let sentiment = "neutral";
    if (positiveScore > negativeScore) sentiment = "positive";
    else if (negativeScore > positiveScore) sentiment = "negative";

    return `Echo Agent Response:

📝 Your message: "${input}"

📊 Analysis:
- Word count: ${wordCount}
- Character count: ${charCount}
- Detected sentiment: ${sentiment}
- Processing time: ${new Date().toLocaleTimeString()}

✨ I've successfully processed your message! Is there anything else you'd like me to echo and analyze?`;
  }
}

// Simple chat agent that provides more conversational responses
export class ChatAgent implements BaseAgent {
  getMetadata(): Agent {
    return {
      name: "chat",
      description: "A friendly conversational agent that provides helpful and engaging responses",
      metadata: {
        capabilities: [
          {
            name: "Conversational AI",
            description: "Provides natural, friendly responses to user queries"
          },
          {
            name: "Context Awareness",
            description: "Maintains context within conversations and provides relevant responses"
          }
        ],
        domains: ["general", "conversation", "assistance"],
        tags: ["chat", "conversation", "ai"],
        framework: "Custom",
        programming_language: "TypeScript", 
        natural_languages: ["en"],
        documentation: "A demonstration chat agent that provides friendly, contextual responses to user messages.",
        license: "Apache-2.0"
      },
      status: {
        avg_run_tokens: 75,
        avg_run_time_seconds: 0.8,
        success_rate: 98.0
      }
    };
  }

  async processMessage(input: Message[]): Promise<Message[]> {
    const userMessage = input[input.length - 1];
    const textContent = this.extractTextContent(userMessage);
    
    const response = this.generateChatResponse(textContent);
    
    return [{
      role: "agent/chat",
      parts: [{
        content_type: "text/plain",
        content: response
      }],
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString()
    }];
  }

  async *processMessageStream(input: Message[]): AsyncGenerator<MessagePart> {
    const userMessage = input[input.length - 1];
    const textContent = this.extractTextContent(userMessage);
    
    const response = this.generateChatResponse(textContent);
    const chunks = response.split('. ');
    
    // Stream sentence by sentence
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] + (i < chunks.length - 1 ? '. ' : '');
      yield {
        content_type: "text/plain",
        content: chunk
      };
      
      // Add delay between sentences
      await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 300));
    }
  }

  private extractTextContent(message: Message): string {
    return message.parts
      .filter(part => part.content_type === "text/plain" && part.content)
      .map(part => part.content)
      .join(" ");
  }

  private generateChatResponse(input: string): string {
    if (!input.trim()) {
      return "Hi there! I'm your chat assistant. How can I help you today?";
    }

    const lowerInput = input.toLowerCase();
    
    // Simple keyword-based responses
    if (lowerInput.includes("hello") || lowerInput.includes("hi")) {
      return "Hello! Great to meet you. What would you like to chat about?";
    }
    
    if (lowerInput.includes("how are you")) {
      return "I'm doing great, thank you for asking! I'm here and ready to help. How are you doing today?";
    }
    
    if (lowerInput.includes("help")) {
      return "I'm here to help! I can have conversations, answer questions, and assist with various topics. What specifically would you like help with?";
    }
    
    if (lowerInput.includes("weather")) {
      return "I don't have access to real-time weather data, but I'd be happy to chat about weather in general! Are you planning any outdoor activities?";
    }
    
    if (lowerInput.includes("time")) {
      return `The current time is ${new Date().toLocaleTimeString()}. Is there something time-sensitive I can help you with?`;
    }
    
    if (lowerInput.includes("thank")) {
      return "You're very welcome! I'm glad I could be helpful. Feel free to ask me anything else!";
    }
    
    // Default response
    return `That's interesting! You mentioned: "${input}". I'd love to hear more about that. What aspects would you like to explore further?`;
  }
}

// Agent registry
export const agents = new Map<string, BaseAgent>([
  ["echo", new EchoAgent()],
  ["chat", new ChatAgent()]
]);

export function getAgent(name: string): BaseAgent | undefined {
  return agents.get(name);
}

export function listAgents(): Agent[] {
  return Array.from(agents.values()).map(agent => agent.getMetadata());
}