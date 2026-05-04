import type { AgentLLMConfig, Logger } from "@atlas/agent-sdk";
import { registry, traceModel } from "@atlas/llm";
import type { LanguageModel, ModelMessage } from "ai";
import { generateObject, generateText, jsonSchema, streamText } from "ai";
import { z } from "zod";

/** Minimal stream emitter for user agents — wiring layer adapts to AtlasUIMessageChunk */
export interface CodeAgentStreamEmitter {
  emit: (event: { type: string } & Record<string, unknown>) => void;
}

/** Host function bindings provided per-execution */
export interface AgentSkillPayload {
  name: string;
  description: string;
  instructions: string;
}

export interface CodeAgentExecutorOptions {
  logger: Logger;
  streamEmitter?: CodeAgentStreamEmitter;
  mcpToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  mcpListTools: () => Promise<Array<{ name: string; description: string; inputSchema: unknown }>>;
  sessionContext: { id: string; workspaceId: string; userId?: string; datetime?: unknown };
  agentConfig?: Record<string, unknown>;
  agentLlmConfig?: AgentLLMConfig;
  env?: Record<string, string>;
  outputSchema?: Record<string, unknown>;
  timeoutMs?: number;
  /** Skills to inject into the execute payload. Body-only, frontmatter stripped. */
  skills?: AgentSkillPayload[];
  /**
   * Propagated from the runtime's per-session AbortController. When aborted,
   * the executor must terminate the subprocess and return promptly so the
   * cancel reaches in-flight tools and the LLM call upstream.
   */
  abortSignal?: AbortSignal;
}

/**
 * ComponentError shape — jco's result-catch-handler extracts .payload from
 * caught errors to produce { tag: "err", val: payload }.
 */
class ComponentError extends Error {
  payload: string;
  constructor(payload: string) {
    super(payload);
    this.payload = payload;
  }
}

/** Maximum HTTP response body size (bytes). Matches platform webfetch limit. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Message content: string for text, array of objects for future content blocks
 * (tool results, images). v1 agents use string exclusively.
 */
const LlmMessageContentSchema = z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]);

const LlmMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: LlmMessageContentSchema,
});

/** Zod schema for LLM generation requests from user agents */
export const LlmRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(LlmMessageSchema).min(1),
  max_tokens: z.number().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  provider_options: z.record(z.string(), z.unknown()).optional(),
});

/** Zod schema for HTTP fetch requests from user agents */
export const HttpFetchRequestSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeout_ms: z.number().positive().optional(),
});

/**
 * Parse JSON from a user agent, throwing ComponentError on malformed input.
 * Without this, JSON.parse throws a raw SyntaxError before Zod runs —
 * the agent gets a cryptic stack trace instead of a clean error message.
 */
export function parseAgentJson(json: string, label: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new ComponentError(`Invalid JSON in ${label} request`);
  }
}

/**
 * Create the llmGenerate handler for binding to globalThis capabilities.
 *
 * Extracted from bindHostFunctions for testability — validates the JSON request,
 * resolves the model, and routes to generateText or generateObject.
 */
export function createLlmGenerateHandler(options: {
  agentLlmConfig?: AgentLLMConfig;
  streamEmitter?: CodeAgentStreamEmitter;
  abortSignal?: AbortSignal;
  logger?: Logger;
}): (requestJson: string) => Promise<string> {
  return async (requestJson: string): Promise<string> => {
    const raw = parseAgentJson(requestJson, "LLM");
    const parsed = LlmRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ComponentError(
        `Invalid LLM request: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }
    const request = parsed.data;
    const modelId = resolveModelId(request.model, options.agentLlmConfig);

    try {
      const model = traceModel(
        registry.languageModel(
          modelId as
            | `anthropic:${string}`
            | `openai:${string}`
            | `google:${string}`
            | `claude-code:${string}`
            | `groq:${string}`,
        ),
      );

      // Derive provider namespace from model ID prefix (e.g. "anthropic" from "anthropic:claude-sonnet-4-5")
      const providerOptions = request.provider_options
        ? {
            [modelId.split(":")[0] as string]: request.provider_options as Record<
              string,
              string | number | boolean | null
            >,
          }
        : undefined;

      // For claude-code models, use streamText to enable progress forwarding
      if (modelId.startsWith("claude-code:")) {
        return await handleClaudeCodeGenerate(model, request, providerOptions, {
          streamEmitter: options.streamEmitter,
          modelId,
          abortSignal: options.abortSignal,
          logger: options.logger,
        });
      }

      if (request.output_schema) {
        const result = await generateObject({
          model,
          messages: request.messages as Array<ModelMessage>,
          schema: jsonSchema(request.output_schema),
          temperature: request.temperature ?? options.agentLlmConfig?.temperature,
          maxOutputTokens: request.max_tokens ?? options.agentLlmConfig?.max_tokens ?? 1024,
          ...(providerOptions && { providerOptions }),
        });

        return JSON.stringify({
          object: result.object,
          model: modelId,
          usage: {
            prompt_tokens: result.usage.inputTokens,
            completion_tokens: result.usage.outputTokens,
          },
          finish_reason: result.finishReason,
        });
      }

      const result = await generateText({
        model,
        messages: request.messages as Array<ModelMessage>,
        temperature: request.temperature ?? options.agentLlmConfig?.temperature,
        maxOutputTokens: request.max_tokens ?? options.agentLlmConfig?.max_tokens ?? 1024,
        ...(providerOptions && { providerOptions }),
      });

      return JSON.stringify({
        text: result.text,
        model: modelId,
        usage: {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
        },
        finish_reason: result.finishReason,
      });
    } catch (error: unknown) {
      if (error instanceof ComponentError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? ` (cause: ${error.cause.message})`
          : "";
      throw new ComponentError(`LLM generation failed: ${reason}${cause}`);
    }
  };
}

/** Inferred type from LlmRequestSchema */
type LlmRequest = z.infer<typeof LlmRequestSchema>;

/** Stall detection interval (10s) and timeout (120s) */
const STALL_CHECK_INTERVAL_MS = 10_000;
const STALL_TIMEOUT_MS = 120_000;

/**
 * Handle LLM generation for claude-code models via streamText.
 *
 * Iterates the full stream to forward tool-call events as human-readable
 * progress via smallLLM, with stall detection that aborts after 120s of
 * inactivity.
 */
async function handleClaudeCodeGenerate(
  model: LanguageModel,
  request: LlmRequest,
  providerOpts: Record<string, Record<string, string | number | boolean | null>> | undefined,
  options: {
    streamEmitter?: CodeAgentStreamEmitter;
    modelId: string;
    abortSignal?: AbortSignal;
    logger?: Logger;
  },
): Promise<string> {
  options.logger?.info("Claude Code stream started", { modelId: options.modelId });
  const controller = new AbortController();

  // If parent aborts (timeout), propagate to our stream
  const onParentAbort = () => controller.abort();
  options.abortSignal?.addEventListener("abort", onParentAbort, { once: true });

  const stream = streamText({
    model,
    messages: request.messages as Array<ModelMessage>,
    ...(providerOpts && { providerOptions: providerOpts }),
    abortSignal: controller.signal,
  });

  // Stall detection: abort if no activity for 120s
  let lastActivityMs = Date.now();
  const stallCheck = setInterval(() => {
    if (Date.now() - lastActivityMs > STALL_TIMEOUT_MS) {
      clearInterval(stallCheck);
      options.logger?.warn("Claude Code stream stalled, aborting", {
        stallTimeoutMs: STALL_TIMEOUT_MS,
      });
      controller.abort();
    }
  }, STALL_CHECK_INTERVAL_MS);

  try {
    for await (const part of stream.fullStream) {
      lastActivityMs = Date.now();
      if (part.type === "tool-call") {
        options.logger?.debug("Claude Code tool call", { toolName: part.toolName });
        if (options.streamEmitter) {
          const progress = generateProgress({ toolName: part.toolName, input: part.input });
          options.streamEmitter.emit({
            type: "data-tool-progress",
            data: { toolName: "Claude Code", content: progress },
          });
        }
      }
    }

    const [text, usage, finishReason] = await Promise.all([
      stream.text,
      stream.usage,
      stream.finishReason,
    ]);
    options.logger?.info("Claude Code stream completed", { modelId: options.modelId });
    return JSON.stringify({
      text,
      model: options.modelId,
      usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens },
      finish_reason: finishReason,
    });
  } finally {
    clearInterval(stallCheck);
    options.abortSignal?.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Generate concise, human-readable progress from a tool invocation.
 *
 * Uses a simple template-based approach. Falls back to descriptive
 * strings based on tool name patterns.
 */
function generateProgress(context: { toolName: string; input: unknown }): string {
  const { toolName, input } = context;

  // Extract a meaningful target from input if available
  const inputObj = typeof input === "object" && input !== null ? input : {};
  const path =
    (inputObj as Record<string, unknown>).path ??
    (inputObj as Record<string, unknown>).file_path ??
    (inputObj as Record<string, unknown>).filename;
  const target = typeof path === "string" ? path.split("/").pop() : undefined;

  // Map common tool name patterns to -ing verbs
  const lower = toolName.toLowerCase();
  if (lower.includes("read")) return target ? `Reading ${target}` : "Reading file";
  if (lower.includes("write")) return target ? `Writing ${target}` : "Writing file";
  if (lower.includes("edit")) return target ? `Editing ${target}` : "Editing file";
  if (lower.includes("search") || lower.includes("grep"))
    return target ? `Searching ${target}` : "Searching";
  if (lower.includes("bash") || lower.includes("exec")) return "Executing command";
  if (lower.includes("glob")) return "Finding files";

  // Default: "Using <ToolName>"
  return `Using ${toolName}`.slice(0, 50);
}

/**
 * Create the httpFetch handler for binding to globalThis capabilities.
 *
 * Extracted from bindHostFunctions for testability — validates the JSON request,
 * performs fetch() with timeout and body size limits.
 * Logs outbound requests at info level for audit observability.
 */
export function createHttpFetchHandler(options: {
  logger: Logger;
}): (requestJson: string) => Promise<string> {
  const { logger } = options;

  return async (requestJson: string): Promise<string> => {
    const raw = parseAgentJson(requestJson, "HTTP");
    const parsed = HttpFetchRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ComponentError(
        `Invalid HTTP request: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }
    const request = parsed.data;

    logger.info("agent outbound HTTP request", { url: request.url, method: request.method });

    try {
      const controller = new AbortController();
      const timeoutMs = request.timeout_ms ?? 30_000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      // Read body with size limit (5MB, matches platform webfetch)
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            reader.cancel();
            throw new ComponentError(
              `HTTP response body exceeds ${MAX_RESPONSE_BYTES} bytes (5MB limit)`,
            );
          }
          chunks.push(value);
        }
      }

      const body = new TextDecoder().decode(
        chunks.length === 1
          ? chunks[0]
          : new Uint8Array(
              chunks.reduce<number[]>((acc, c) => {
                acc.push(...c);
                return acc;
              }, []),
            ),
      );

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      logger.info("agent outbound HTTP response", {
        url: request.url,
        method: request.method,
        status: response.status,
      });

      return JSON.stringify({ status: response.status, headers, body });
    } catch (error: unknown) {
      if (error instanceof ComponentError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? ` (cause: ${error.cause.message})`
          : "";
      throw new ComponentError(`HTTP fetch failed: ${reason}${cause}`);
    }
  };
}

/**
 * Resolve a model ID from the per-call request and agent LLM config.
 *
 * Priority: request.model > agent config > error.
 * Handles "provider:model" (fully qualified) and bare "model" formats.
 */
export function resolveModelId(
  requestModel: string | undefined,
  agentConfig: AgentLLMConfig | undefined,
): string {
  if (requestModel) {
    if (requestModel.includes(":")) return requestModel;
    if (agentConfig?.provider) return `${agentConfig.provider}:${requestModel}`;
    return requestModel;
  }

  if (agentConfig?.model) {
    const model = agentConfig.model;
    if (model.includes(":")) return model;
    if (agentConfig.provider) return `${agentConfig.provider}:${model}`;
    return model;
  }

  throw new Error("No model specified and no default in agent LLM config");
}

/**
 * Serialize execution context to JSON for the agent subprocess.
 *
 * Converts camelCase TypeScript fields to snake_case for the Python SDK
 * and applies default values for optional fields.
 */
export function serializeAgentContext(options: CodeAgentExecutorOptions): string {
  const sessionContext = options.sessionContext ?? { id: "", workspaceId: "" };
  return JSON.stringify({
    env: options.env ?? {},
    config: options.agentConfig ?? {},
    session: {
      id: sessionContext.id,
      workspace_id: sessionContext.workspaceId,
      user_id: sessionContext.userId ?? "",
      datetime: sessionContext.datetime ?? "",
    },
    llm_config: options.agentLlmConfig,
    output_schema: options.outputSchema,
    ...(options.skills && options.skills.length > 0 && { skills: options.skills }),
  });
}
