/**
 * ConversationAgent - System agent for interactive conversations
 * Extends BaseAgent with conversation-specific capabilities
 */

import { BaseAgent } from "../../../src/core/agents/base-agent.ts";
import type { IAtlasAgent } from "../../../src/types/core.ts";

export interface ConversationAgentConfig {
  model?: string;
  system_prompt?: string;
  tools?: string[];
  temperature?: number;
  max_tokens?: number;
}

export class ConversationAgent extends BaseAgent implements IAtlasAgent {
  private config: ConversationAgentConfig;

  constructor(config: ConversationAgentConfig = {}, id?: string) {
    super(undefined, id);

    this.config = {
      model: "claude-4-sonnet-20250514",
      system_prompt: "You are a helpful AI assistant for Atlas workspace conversations.",
      tools: [],
      temperature: 0.7,
      max_tokens: 2000,
      ...config,
    };

    // Set agent prompts based on configuration
    this.setPrompts(
      this.config.system_prompt || "You are a helpful AI assistant.",
      "",
    );
  }

  // IAtlasAgent interface implementation
  name(): string {
    return "ConversationAgent";
  }

  nickname(): string {
    return "chat";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "atlas-system";
  }

  purpose(): string {
    return "Interactive conversation agent for workspace collaboration";
  }

  controls(): object {
    return {
      model: this.config.model,
      temperature: this.config.temperature,
      max_tokens: this.config.max_tokens,
      tools: this.config.tools,
    };
  }

  /**
   * Get default model for this agent
   */
  protected override getDefaultModel(): string {
    return this.config.model || super.getDefaultModel();
  }

  /**
   * Static method to get agent metadata for registry
   */
  static getMetadata() {
    return {
      id: "conversation",
      name: "ConversationAgent",
      type: "system" as const,
      version: "1.0.0",
      provider: "atlas-system",
      description: "Interactive conversation agent for workspace collaboration",
      capabilities: [
        "text-generation",
        "conversation",
        "memory-enhanced",
        "context-aware",
      ],
      configSchema: {
        model: { type: "string", default: "claude-4-sonnet-20250514" },
        system_prompt: { type: "string", default: "You are a helpful AI assistant." },
        tools: { type: "array", default: [] },
        temperature: { type: "number", default: 0.7, min: 0, max: 2 },
        max_tokens: { type: "number", default: 2000, min: 1 },
      },
    };
  }

  /**
   * Validate configuration for this agent type
   */
  static validateConfig(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (config.model && typeof config.model !== "string") {
      errors.push("model must be a string");
    }

    if (config.system_prompt && typeof config.system_prompt !== "string") {
      errors.push("system_prompt must be a string");
    }

    if (config.tools && !Array.isArray(config.tools)) {
      errors.push("tools must be an array");
    }

    if (config.temperature !== undefined) {
      if (
        typeof config.temperature !== "number" || config.temperature < 0 || config.temperature > 2
      ) {
        errors.push("temperature must be a number between 0 and 2");
      }
    }

    if (config.max_tokens !== undefined) {
      if (typeof config.max_tokens !== "number" || config.max_tokens < 1) {
        errors.push("max_tokens must be a positive number");
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
