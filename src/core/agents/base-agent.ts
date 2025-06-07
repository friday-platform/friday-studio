import type { IAtlasAgent, IAtlasScope, ITempestContextManager, ITempestMemoryManager, ITempestMessageManager } from "../../types/core.ts";
import { ContextManager as Context } from "../context.ts";
import { MemoryManager as Memory } from "../memory.ts";
import { MessageManager as Messages } from "../messages.ts";
import { createAnthropic } from "npm:@ai-sdk/anthropic";
import { generateText, streamText } from "npm:ai";

export abstract class BaseAgent implements IAtlasAgent, IAtlasScope {
  id: string;
  parentScopeId?: string;
  supervisor?: any;
  context: ITempestContextManager;
  memory: ITempestMemoryManager;
  messages: ITempestMessageManager;
  prompts: { system: string; user: string };
  gates: any[] = [];
  
  constructor(id?: string) {
    this.id = id || crypto.randomUUID();
    this.context = new Context();
    this.memory = new Memory();
    this.messages = new Messages();
    this.prompts = {
      system: "",
      user: ""
    };
  }
  
  // IAtlasAgent interface methods
  abstract name(): string;
  abstract nickname(): string;
  abstract version(): string;
  abstract provider(): string;
  abstract purpose(): string;
  abstract controls(): object;
  
  getAgentPrompts(): { system: string; user: string } {
    return this.prompts;
  }
  
  scope(): IAtlasScope {
    return this;
  }
  
  // IAtlasScope methods
  newConversation(): ITempestMessageManager {
    return new Messages();
  }
  
  getConversation(): ITempestMessageManager {
    return this.messages;
  }
  
  archiveConversation(): void {
    // TODO: Implement conversation archiving
  }
  
  deleteConversation(): void {
    this.messages = new Messages();
  }
  
  // Utility methods for logging
  protected log(message: string, context?: any): void {
    const prefix = `[${this.name()}]`;
    if (context) {
      console.log(prefix, message, context);
    } else {
      console.log(prefix, message);
    }
  }
  
  // LLM generation methods
  protected async generateLLM(model: string, systemPrompt: string, userPrompt: string): Promise<string> {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY not found in environment variables");
    }
    
    const anthropic = createAnthropic({ apiKey });
    
    try {
      const { text } = await generateText({
        model: anthropic(model),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.7,
        maxTokens: 2000
      });
      
      return text;
    } catch (error) {
      this.log(`LLM generation error: ${error}`);
      throw error;
    }
  }
  
  protected async *generateLLMStream(model: string, systemPrompt: string, userPrompt: string): AsyncGenerator<string> {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY not found in environment variables");
    }
    
    const anthropic = createAnthropic({ apiKey });
    
    try {
      const { textStream } = await streamText({
        model: anthropic(model),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.7,
        maxTokens: 2000
      });
      
      for await (const chunk of textStream) {
        yield chunk;
      }
    } catch (error) {
      this.log(`LLM stream generation error: ${error}`);
      throw error;
    }
  }
}