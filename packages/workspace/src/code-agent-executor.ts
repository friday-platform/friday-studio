/**
 * CodeAgentExecutor — loads and runs WASM code agents with real host function bindings.
 *
 * The executor writes a `capabilities.js` trampoline into the agent directory,
 * sets per-execution host functions via a global, dynamic-imports the transpiled
 * agent module, calls execute(), and converts the WIT result variant into an
 * AgentResult.
 *
 * Defense-in-depth: the Python SDK bridge catches most errors. The executor wraps
 * the entire execute() call in try/catch so a WASM trap (OOM, stack overflow) or
 * a bridge bug always produces AgentResult.err, never an unhandled exception.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentLLMConfig, AgentMetadata, AgentResult, Logger } from "@atlas/agent-sdk";
import { registry, smallLLM, traceModel } from "@atlas/llm";
import type { LanguageModel, ModelMessage } from "ai";
import { generateObject, generateText, jsonSchema, streamText } from "ai";
import { z } from "zod";

/** WIT result variant shape produced by jco's result-catch-handler */
interface WitResultVariant {
  tag: "ok" | "err";
  val: string;
}

/** Transpiled WASM agent module shape after jco transpile */
interface WasmAgentModule {
  getMetadata(): string;
  execute(prompt: string, context: string): Promise<WitResultVariant>;
}

/** Minimal stream emitter for code agents — wiring layer adapts to AtlasUIMessageChunk */
export interface CodeAgentStreamEmitter {
  emit: (event: { type: string; data: unknown }) => void;
}

/** Host function bindings provided per-execution */
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
}

/** Default execution timeout (3 minutes) */
const DEFAULT_TIMEOUT_MS = 180_000;

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

/** Zod schema for LLM generation requests from WASM agents */
export const LlmRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(LlmMessageSchema).min(1),
  max_tokens: z.number().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  provider_options: z.record(z.string(), z.unknown()).optional(),
});

/** Zod schema for HTTP fetch requests from WASM agents */
export const HttpFetchRequestSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeout_ms: z.number().positive().optional(),
});

/**
 * Parse JSON from a WASM agent, throwing ComponentError on malformed input.
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
          const progress = await generateProgress({ toolName: part.toolName, input: part.input });
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
 * Uses smallLLM() — same approach as the TS claude-code agent.
 */
async function generateProgress(context: { toolName: string; input: unknown }): Promise<string> {
  const contextStr = JSON.stringify(context, null, 2);
  return await smallLLM({
    system: `Format tool invocation as single-line status. Output only the status line, no explanations.

<rules>
- Single line, ≤50 chars
- Use -ing verbs: Reading, Writing, Executing
- Preserve technical terms, numbers, HTTP codes, filenames
- Abbreviate long paths to filename only (>20 chars)
- Remove articles: the, this, my, a, an
</rules>

<examples>
Write to /tmp/agent-output.txt → "Writing agent-output.txt"
Read package.json → "Reading package.json"
</examples>`,
    prompt: contextStr,
    maxOutputTokens: 250,
  });
}

/**
 * Create the httpFetch handler for binding to globalThis capabilities.
 *
 * Extracted from bindHostFunctions for testability — validates the JSON request,
 * performs fetch() on behalf of the WASM agent with timeout and body size limits.
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
 * Capabilities trampoline module content.
 * Reads host functions from globalThis.__fridayCapabilities at call time.
 * This file is written to the agent directory before each execution.
 */
const CAPABILITIES_TRAMPOLINE = `\
// Auto-generated by CodeAgentExecutor — do not edit
const c = () => globalThis.__fridayCapabilities;

export async function callTool(name, args) {
  return c().callTool(name, args);
}

export function listTools() {
  return c().listTools();
}

export function log(level, message) {
  c().log(level, message);
}

export function streamEmit(eventType, data) {
  c().streamEmit(eventType, data);
}

export async function llmGenerate(request) {
  return c().llmGenerate(request);
}

export async function httpFetch(request) {
  return c().httpFetch(request);
}
`;

/** Log level mapping: WIT u8 → logger method name */
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

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
 * Serialize execution context to JSON for the WASM agent.
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
  });
}

export class CodeAgentExecutor {
  /** Aborted on timeout to kill in-flight LLM calls (esp. claude-code subprocess) */
  private executionAbortController: AbortController | null = null;

  /**
   * Execute a WASM code agent.
   *
   * @param sourceLocation - Path to the agent version directory (contains agent.js)
   * @param prompt - Input prompt for the agent
   * @param options - Host function bindings and execution context
   */
  async execute(
    sourceLocation: string,
    prompt: string,
    options: CodeAgentExecutorOptions,
  ): Promise<AgentResult> {
    const startTime = performance.now();
    const agentDir = resolve(sourceLocation);
    const agentJsPath = join(agentDir, "agent.js");
    let agentId = "unknown";

    try {
      // Pre-resolve tools (listTools is sync in WIT, can't await inside the call)
      const resolvedTools = await options.mcpListTools();
      options.logger.debug("Resolved MCP tools", { count: resolvedTools.length });

      // Write capabilities trampoline and set global bindings
      await this.writeCapabilities(agentDir);
      this.executionAbortController = new AbortController();
      this.bindHostFunctions(options, resolvedTools);

      // Dynamic import with cache-busting to get fresh module per execution
      const agentModule = await import(`${agentJsPath}?t=${Date.now()}`);
      const agent: WasmAgentModule = agentModule.agent;
      options.logger.info("WASM agent loaded", { agentId, sourceLocation });

      // Read agent ID from metadata
      try {
        const meta = JSON.parse(agent.getMetadata()) as AgentMetadata;
        agentId = meta.id;
      } catch {
        // Non-fatal — use "unknown" as fallback
      }

      // Build execution context — Python SDK expects snake_case keys
      const contextJson = serializeAgentContext(options);

      // Execute with timeout
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      options.logger.info("Starting agent execution", { agentId, timeoutMs });
      const result = await this.executeWithTimeout(agent, prompt, contextJson, timeoutMs);
      options.logger.info("Agent execution completed", {
        agentId,
        tag: result.tag,
        durationMs: performance.now() - startTime,
      });

      const durationMs = performance.now() - startTime;

      // Convert WIT variant to AgentResult
      if (result.tag === "ok") {
        // Python SDK bridge produces a JSON envelope: {"data": ..., "artifactRefs": [...], ...}
        // Parse it to extract extras; fall back to raw string if not valid JSON.
        let data: unknown = result.val;
        let artifactRefs: unknown[] | undefined;
        let outlineRefs: unknown[] | undefined;
        let reasoning: string | undefined;

        try {
          const parsed = JSON.parse(result.val) as Record<string, unknown>;
          if (parsed !== null && typeof parsed === "object" && "data" in parsed) {
            data = parsed.data;
            artifactRefs = parsed.artifactRefs as unknown[] | undefined;
            outlineRefs = parsed.outlineRefs as unknown[] | undefined;
            reasoning = parsed.reasoning as string | undefined;
          }
        } catch {
          // Not JSON — use raw string as data (graceful degradation)
        }

        return {
          agentId,
          timestamp: new Date().toISOString(),
          input: prompt,
          ok: true,
          data,
          artifactRefs: artifactRefs as
            | Array<{ id: string; type: string; summary: string }>
            | undefined,
          outlineRefs: outlineRefs as
            | Array<{
                service: string;
                title: string;
                content?: string;
                artifactId?: string;
                artifactLabel?: string;
                type?: string;
              }>
            | undefined,
          reasoning,
          durationMs,
        };
      }

      return {
        agentId,
        timestamp: new Date().toISOString(),
        input: prompt,
        ok: false,
        error: { reason: result.val },
        durationMs,
      };
    } catch (error: unknown) {
      // Defense-in-depth: WASM trap, JSPI error, or anything that escaped
      const durationMs = performance.now() - startTime;
      const reason =
        error instanceof Error ? error.message : `WASM execution failed: ${String(error)}`;
      options.logger.error("Agent execution failed", { agentId, error: reason, durationMs });

      return {
        agentId,
        timestamp: new Date().toISOString(),
        input: prompt,
        ok: false,
        error: { reason },
        durationMs,
      };
    } finally {
      // Clean up global bindings
      delete (globalThis as Record<string, unknown>).__fridayCapabilities;
      this.executionAbortController = null;
    }
  }

  /** Write the capabilities trampoline to the agent directory */
  private async writeCapabilities(agentDir: string): Promise<void> {
    // Check if agent.js imports from ./capabilities.js (built agents).
    // If it imports from a different path (e.g. test fixtures with ../capabilities-stub.js),
    // write the trampoline to that path instead.
    const agentJsPath = join(agentDir, "agent.js");
    const agentJs = await readFile(agentJsPath, "utf-8");

    const capabilitiesPath = this.resolveCapabilitiesPath(agentJs, agentDir);
    await writeFile(capabilitiesPath, CAPABILITIES_TRAMPOLINE);
  }

  /**
   * Find the capabilities import path from the transpiled agent.js.
   * jco always emits the capabilities import as the first user import after "use jco".
   */
  private resolveCapabilitiesPath(agentJs: string, agentDir: string): string {
    // Match: import { callTool, ... } from '<path>';
    const match = agentJs.match(/import\s*\{[^}]*callTool[^}]*\}\s*from\s*['"]([^'"]+)['"]/);
    if (match?.[1]) {
      return resolve(agentDir, match[1]);
    }
    // Fallback: built agents use ./capabilities.js
    return join(agentDir, "capabilities.js");
  }

  /** Set per-execution host functions on the global */
  private bindHostFunctions(
    options: CodeAgentExecutorOptions,
    resolvedTools: Array<{ name: string; description: string; inputSchema: unknown }>,
  ): void {
    const { logger, streamEmitter, mcpToolCall } = options;

    (globalThis as Record<string, unknown>).__fridayCapabilities = {
      /**
       * callTool: async host function bound through JSPI.
       * Returns plain string on success, throws ComponentError on failure.
       * jco's result-catch-handler wraps these as { tag: "ok", val } / { tag: "err", val }.
       */
      async callTool(name: string, argsJson: string): Promise<string> {
        const args = JSON.parse(argsJson) as Record<string, unknown>;
        try {
          const result = await mcpToolCall(name, args);
          return JSON.stringify(result);
        } catch (error: unknown) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new ComponentError(reason);
        }
      },

      /** listTools: sync — tools pre-resolved before execution */
      listTools(): Array<{ name: string; description: string; inputSchema: string }> {
        return resolvedTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema:
            typeof t.inputSchema === "string" ? t.inputSchema : JSON.stringify(t.inputSchema),
        }));
      },

      /** log: maps WIT u8 level to Logger method */
      log(level: number, message: string): void {
        const methodName = LOG_LEVELS[level] ?? "info";
        logger[methodName](message, { source: "wasm-agent" });
      },

      /** streamEmit: forwards to StreamEmitter if provided */
      streamEmit(eventType: string, data: string): void {
        if (!streamEmitter) return;
        try {
          streamEmitter.emit({ type: eventType, data: JSON.parse(data) });
        } catch {
          streamEmitter.emit({ type: eventType, data });
        }
      },

      /** llmGenerate: async host function for LLM inference */
      llmGenerate: createLlmGenerateHandler({
        agentLlmConfig: options.agentLlmConfig,
        streamEmitter,
        abortSignal: this.executionAbortController?.signal,
        logger: options.logger,
      }),

      /** httpFetch: async host function for outbound HTTP */
      httpFetch: createHttpFetchHandler({ logger }),
    };
  }

  /** Execute with a timeout wrapper — aborts in-flight LLM calls on timeout */
  private executeWithTimeout(
    agent: WasmAgentModule,
    prompt: string,
    contextJson: string,
    timeoutMs: number,
  ): Promise<WitResultVariant> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        this.executionAbortController?.abort();
        reject(new Error(`Agent execution timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    return Promise.race([agent.execute(prompt, contextJson), timeoutPromise]);
  }
}
