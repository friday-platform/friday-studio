/**
 * Adapter for @atlas/llm registry to work with FSM engine's LLMProvider interface
 */

import { registry } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { generateText } from "ai";
import type { z } from "zod";
import { jsonSchemaToZod } from "./json-schema-to-zod.ts";
import type {
  JSONSchema,
  LLMProvider,
  LLMResponse,
  ToolDefinition,
  ToolExecutor,
} from "./types.ts";

/**
 * Tool object structure expected by AI SDK
 * We construct this directly rather than using the tool() helper to avoid
 * complex generic type constraints that can't be satisfied with dynamic schemas
 */
interface AISDKTool<TSchema extends z.ZodType = z.ZodType> {
  description: string;
  inputSchema: TSchema;
  execute: (args: z.infer<TSchema>) => Promise<unknown>;
}

/**
 * Create an AI SDK tool from dynamic Zod schema
 * Runtime Zod validation ensures type safety despite dynamic schema conversion
 */
function createAITool<TSchema extends z.ZodType>(
  description: string,
  schema: TSchema,
  execute: (args: z.infer<TSchema>) => Promise<unknown>,
): AISDKTool<TSchema> {
  return { description, inputSchema: schema, execute };
}

/**
 * Wraps @atlas/llm's registry to match FSM engine's interface
 */
export class AtlasLLMProviderAdapter implements LLMProvider {
  constructor(
    private defaultModel: string,
    private provider: "anthropic" | "openai" | "google" = "anthropic",
  ) {}

  async call(params: {
    model: string;
    prompt: string;
    tools?: ToolDefinition[];
    toolExecutors?: Record<string, ToolExecutor>;
  }): Promise<LLMResponse> {
    const modelId = `${this.provider}:${params.model || this.defaultModel}` as
      | `anthropic:${string}`
      | `openai:${string}`
      | `google:${string}`;

    // Build AI SDK tool definitions if tools are provided
    const aiTools =
      params.tools && params.toolExecutors
        ? Object.fromEntries(
            params.tools.map((toolDef) => {
              // Convert JSON Schema to Zod schema for AI SDK
              // This bridges between our JSON Schema-based tool definitions
              // and the AI SDK's Zod-based type system
              const zodSchema = jsonSchemaToZod(toolDef.input_schema as JSONSchema);

              // Create AI SDK tool with proper typing
              // Runtime Zod validation ensures args match the schema
              const aiTool = createAITool(toolDef.description, zodSchema, async (args) => {
                const executor = params.toolExecutors?.[toolDef.name];
                if (!executor) {
                  throw new Error(`Tool executor not found: ${toolDef.name}`);
                }

                logger.info(`Executing tool: ${toolDef.name}`, { args });
                try {
                  // Tools receive a minimal context (no emit/updateDoc since they're read-only)
                  const context = { documents: [], state: "" };
                  const result = await executor(args as Record<string, unknown>, context);
                  logger.info(`Tool ${toolDef.name} completed`, { result });
                  return result;
                } catch (error) {
                  logger.error(`Tool ${toolDef.name} failed`, { error });
                  throw error;
                }
              });

              return [toolDef.name, aiTool];
            }),
          )
        : undefined;

    const response = await generateText({
      model: registry.languageModel(modelId),
      prompt: params.prompt,
      tools: aiTools,
    });

    return {
      content: response.text,
      data:
        response.toolCalls && response.toolCalls.length > 0
          ? {
              toolCalls: response.toolCalls.map((tc) => ({
                name: tc.toolName,
                input: "args" in tc ? tc.args : undefined,
              })),
              toolResults: response.toolResults?.map((tr) => ({
                toolName: "toolName" in tr ? tr.toolName : undefined,
                result: "result" in tr ? tr.result : undefined,
              })),
            }
          : undefined,
    };
  }
}
