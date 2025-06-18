import { ITemplateEngine, TemplateConfig, ValidationResult } from "../types.ts";
import { generateObject, generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

export interface PromptTemplateConfig {
  prompt: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  schema?: Record<string, any>;
  format_instructions?: string;
}

/**
 * LLM-powered template engine using prompts to generate content
 */
export class PromptTemplateEngine implements ITemplateEngine {
  readonly type = "prompt";

  canHandle(template: TemplateConfig): boolean {
    return template.engine === "prompt" || template.engine === "llm";
  }

  async apply(template: TemplateConfig, data: any): Promise<string> {
    const config = template.config as PromptTemplateConfig;

    if (!config.prompt) {
      throw new Error("Prompt template requires 'prompt' in config");
    }

    const model = anthropic(config.model || "claude-3-5-sonnet-20241022");

    // Build the full prompt
    const fullPrompt = this.buildPrompt(config, data, template.format);

    try {
      // Use generateText for all outputs - simpler and more reliable
      const result = await generateText({
        model,
        prompt: fullPrompt,
        temperature: config.temperature || 0.3,
        maxTokens: config.max_tokens || 4000,
      });

      return result.text;
    } catch (error) {
      throw new Error(
        `Template generation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  validate(template: TemplateConfig): ValidationResult {
    const config = template.config as PromptTemplateConfig;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.prompt) {
      errors.push("Template config must include 'prompt'");
    }

    if (config.prompt && config.prompt.length < 10) {
      warnings.push("Prompt is very short, consider adding more detail");
    }

    if (config.temperature && (config.temperature < 0 || config.temperature > 2)) {
      errors.push("Temperature must be between 0 and 2");
    }

    if (config.max_tokens && config.max_tokens > 8000) {
      warnings.push("Max tokens is very high, consider reducing for cost efficiency");
    }

    if (template.format === "json" && !config.schema) {
      warnings.push("JSON format specified but no schema provided");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private buildPrompt(config: PromptTemplateConfig, data: any, format: string): string {
    let prompt = config.prompt;

    // Add format-specific instructions
    const formatInstructions = this.getFormatInstructions(format);
    if (formatInstructions) {
      prompt += `\n\n${formatInstructions}`;
    }

    // Add custom format instructions if provided
    if (config.format_instructions) {
      prompt += `\n\n${config.format_instructions}`;
    }

    // Add data section
    prompt += `\n\nData to analyze:\n${JSON.stringify(data, null, 2)}`;

    // Add final generation instruction
    prompt +=
      `\n\nGenerate a ${format} document based on this data following the instructions above.`;

    return prompt;
  }

  private getFormatInstructions(format: string): string | null {
    switch (format) {
      case "markdown":
        return "Use proper markdown formatting with headers (# ## ###), code blocks (```), tables, and lists. Include emojis sparingly for section headers only.";

      case "json":
        return "Output valid JSON only. Ensure all strings are properly escaped and the structure follows the provided schema.";

      case "html":
        return "Generate semantic HTML with proper tags. Include CSS classes for styling. Ensure the output is valid HTML5.";

      case "text":
        return "Generate plain text with clear structure using line breaks and spacing. No special formatting.";

      default:
        return null;
    }
  }
}
