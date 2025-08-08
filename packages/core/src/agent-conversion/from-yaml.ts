/**
 * YAML to SDK Agent Conversion
 *
 * Converts .agent.yml files into AtlasAgent instances. Handles LLM
 * provider setup, tool filtering, and environment validation.
 */

import { generateText, streamText } from "ai";
import { createAgent } from "@atlas/agent-sdk";
import type {
  AgentContext,
  AgentHandler,
  AtlasAgent,
  AtlasTool,
  StreamEvent,
} from "@atlas/agent-sdk";
import type { YAMLAgentDefinition } from "./yaml/schema.ts";
import { extractToolAllowlist, extractToolDenylist } from "./yaml/parser.ts";
import { registry, validateProviderConfig } from "../llm-provider-registry/index.ts";
import { createLogger } from "@atlas/logger";

/**
 * Convert parsed YAML definition to AtlasAgent.
 * Applies tool filtering and environment validation from .agent.yml files.
 */
export function convertYAMLToAgent(yaml: YAMLAgentDefinition): AtlasAgent {
  // Environment validation is handled during YAML parsing in parseYAMLAgentContent

  const logger = createLogger({ component: "YAMLAgent" });
  const llmConfig = yaml.llm;
  const streaming = llmConfig.streaming?.enabled ?? true;
  const maxRetries = 0;

  validateProviderConfig(llmConfig.provider);
  const model = registry.languageModel(`${llmConfig.provider}:${llmConfig.model}`);
  const handler: AgentHandler = async (prompt: string, context: AgentContext): Promise<unknown> => {
    try {
      const allowlists = extractToolAllowlist(yaml);
      const denylists = extractToolDenylist(yaml);
      const allTools = await collectAndFilterTools(context, allowlists, denylists, logger);
      const commonOptions = {
        model,
        system: llmConfig.prompt,
        messages: [{ role: "user" as const, content: prompt }],
        tools: allTools,
        toolChoice: llmConfig.tool_choice || "auto",
        temperature: llmConfig.temperature,
        maxTokens: llmConfig.max_tokens,
        maxRetries,
        maxSteps: llmConfig.max_steps || 10,
        ...(llmConfig.provider_options || {}),
      };
      if (streaming && context.stream) {
        return await handleStreamingResponse(commonOptions, context);
      } else {
        return await handleNonStreamingResponse(commonOptions);
      }
    } catch (error) {
      if (context.stream) {
        const errorEvent: StreamEvent = {
          type: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        };
        context.stream.emit(errorEvent);
      }
      throw error;
    }
  };

  return createAgent({
    id: yaml.agent.id,
    displayName: yaml.agent.displayName,
    version: yaml.agent.version,
    description: yaml.agent.description,
    expertise: yaml.agent.expertise,
    metadata: yaml.agent.metadata,
    handler,
    environment: yaml.environment,
    mcp: yaml.mcp_servers,
  });
}

/** Collect MCP tools and apply YAML-defined allow/deny filters. */
async function collectAndFilterTools(
  context: AgentContext,
  allowlists: Record<string, string[]>,
  denylists: Record<string, string[]>,
  logger: ReturnType<typeof createLogger>,
): Promise<Record<string, AtlasTool>> {
  const allTools: Record<string, AtlasTool> = {};

  try {
    const tools = await context.mcp.getTools();
    const filteredTools = filterAllTools(tools, allowlists, denylists);
    Object.assign(allTools, filteredTools);
  } catch (error) {
    logger.error("Failed to get tools from MCP", { error });
  }

  return allTools;
}

/** Apply server-specific tool allow/deny lists. */
function filterAllTools(
  tools: Record<string, AtlasTool>,
  allowlists: Record<string, string[]>,
  denylists: Record<string, string[]>,
): Record<string, AtlasTool> {
  const filtered: Record<string, AtlasTool> = {};

  for (const [toolName, tool] of Object.entries(tools)) {
    let shouldInclude = true;
    for (const allowlist of Object.values(allowlists)) {
      if (allowlist.length > 0 && !allowlist.includes(toolName)) {
        shouldInclude = false;
        break;
      }
    }

    for (const denylist of Object.values(denylists)) {
      if (denylist.includes(toolName)) {
        shouldInclude = false;
        break;
      }
    }

    if (shouldInclude) {
      filtered[toolName] = tool;
    }
  }

  return filtered;
}

/** Handle streaming LLM response with event emission. */
async function handleStreamingResponse(
  options: Parameters<typeof streamText>[0],
  context: AgentContext,
): Promise<unknown> {
  const result = streamText(options);
  let fullText = "";
  const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
  for await (const chunk of result.textStream) {
    fullText += chunk;
    const textEvent: StreamEvent = {
      type: "text",
      content: chunk,
    };
    context.stream!.emit(textEvent);
  }

  const finalResult = await result;
  const toolCallsArray = await finalResult.toolCalls;
  if (toolCallsArray && toolCallsArray.length > 0) {
    for (const toolCall of toolCallsArray) {
      const toolCallEvent: StreamEvent = {
        type: "tool-call",
        toolName: toolCall.toolName,
        args: toolCall.input,
      };
      context.stream!.emit(toolCallEvent);
      toolCalls.push({
        id: toolCall.toolCallId,
        name: toolCall.toolName,
        args: toolCall.input,
      });
    }
  }

  const usage = await finalResult.usage;
  if (usage) {
    const usageEvent: StreamEvent = {
      type: "usage",
      tokens: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        total: usage.totalTokens,
      },
    };
    context.stream!.emit(usageEvent);
  }

  const finishEvent: StreamEvent = { type: "finish" };
  context.stream!.emit(finishEvent);

  return {
    response: fullText,
    toolCalls,
    usage: usage
      ? {
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      }
      : undefined,
  };
}

/** Handle non-streaming LLM response. */
async function handleNonStreamingResponse(
  options: Parameters<typeof generateText>[0],
): Promise<unknown> {
  const result = await generateText(options);

  const toolCalls = result.toolCalls?.map((tc) => ({
    id: tc.toolCallId,
    name: tc.toolName,
    args: tc.input,
  })) || [];

  return {
    response: result.text,
    toolCalls,
    usage: result.usage
      ? {
        promptTokens: result.usage.inputTokens,
        completionTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
      }
      : undefined,
  };
}

/**
 * Create timeout watchdog with progress and total time limits.
 * Used by YAML agents to enforce timeout configuration.
 */
export function createWatchdogTimer(
  timeout: { progressTimeout?: string; maxTotalTimeout?: string },
  onTimeout: () => void,
) {
  let progressTimer: number | undefined;
  let totalTimer: number | undefined;
  let aborted = false;

  const parseTimeout = (duration: string): number => {
    const match = duration.match(/^(\d+)([smh])$/);
    if (!match) throw new Error(`Invalid timeout format: ${duration}`);

    const value = parseInt(match[1]!);
    const unit = match[2]!;

    switch (unit) {
      case "s":
        return value * 1000;
      case "m":
        return value * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      default:
        throw new Error(`Invalid timeout unit: ${unit}`);
    }
  };

  const start = () => {
    if (timeout.progressTimeout) {
      const progressMs = parseTimeout(timeout.progressTimeout);
      progressTimer = setTimeout(() => {
        if (!aborted) {
          aborted = true;
          onTimeout();
        }
      }, progressMs);
    }

    if (timeout.maxTotalTimeout) {
      const totalMs = parseTimeout(timeout.maxTotalTimeout);
      totalTimer = setTimeout(() => {
        if (!aborted) {
          aborted = true;
          onTimeout();
        }
      }, totalMs);
    }
  };

  const reportProgress = () => {
    if (progressTimer) {
      clearTimeout(progressTimer);
      if (timeout.progressTimeout && !aborted) {
        const progressMs = parseTimeout(timeout.progressTimeout);
        progressTimer = setTimeout(() => {
          if (!aborted) {
            aborted = true;
            onTimeout();
          }
        }, progressMs);
      }
    }
  };

  const stop = () => {
    aborted = true;
    if (progressTimer) clearTimeout(progressTimer);
    if (totalTimer) clearTimeout(totalTimer);
  };

  return { start, reportProgress, stop };
}
