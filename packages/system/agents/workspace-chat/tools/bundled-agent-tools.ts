/**
 * Factory wrapping an `AtlasAgent` as an AI SDK `tool({...})` so the workspace
 * chat parent (and, via the delegate's tool-set thunk, the child) can invoke
 * Friday's bundled agents directly in one step.
 *
 * ## Tool naming
 *
 * Tool name is `agent_${atlasAgent.metadata.id}`. Agent IDs match
 * `/^[a-z0-9-]+$/` (per `AgentMetadataSchema`), so dashes pass through
 * verbatim — Anthropic and OpenAI both accept `^[a-zA-Z0-9_-]{1,64}$` for
 * tool names. No normalization needed; `agent_data-analyst` and
 * `agent_google-calendar` are valid.
 *
 * ## Env gating
 *
 * Mirrors {@link createWebSearchTool}: if any `agent.environmentConfig.required`
 * key is missing or empty in `deps.env`, return `{}` so the LLM never sees a
 * tool it can't run. Composers spread the result, so an empty object is a
 * no-op.
 *
 * ## Stream bridge
 *
 * Constructs an `AgentContext` whose `stream` is a {@link CallbackStreamEmitter}
 * that forwards every event to `deps.writer.write(event)`. The two types are
 * structurally identical: `AtlasUIMessageChunk` =
 * `UIMessageChunk<MessageMetadata, AtlasDataEvents>` is the same type
 * `UIMessageStreamWriter<AtlasUIMessage>.write()` accepts (see
 * `packages/agent-sdk/src/messages.ts:306`), so no mapping layer is needed.
 *
 * @module
 */

import type {
  AgentContext,
  AgentSessionData,
  AtlasAgent,
  AtlasTool,
  AtlasTools,
  AtlasUIMessage,
} from "@atlas/agent-sdk";
import type { PlatformModels } from "@atlas/agent-sdk/types";
import { CallbackStreamEmitter } from "@atlas/core/streaming";
import type { Logger } from "@atlas/logger";
import { tool, type UIMessageStreamWriter } from "ai";
import { z } from "zod";

/**
 * Shared dependencies passed at registration time. The factory uses these to
 * construct the per-call `AgentContext` it hands to `agent.execute()`.
 *
 * `tools` and `memory` are forwarded verbatim if provided — the wrapped agent
 * decides whether it needs them.
 */
export interface CreateAgentToolDeps {
  writer: UIMessageStreamWriter<AtlasUIMessage>;
  session: AgentSessionData;
  platformModels: PlatformModels;
  abortSignal: AbortSignal | undefined;
  env: Record<string, string>;
  logger: Logger;
  tools?: AgentContext["tools"];
  memory?: AgentContext["memory"];
}

/** Symbol key used to store agent-tool metadata for delegate re-binding. */
export const AGENT_TOOL_META = Symbol.for("atlas.agent-tool-meta");

/** JSON-stringify with a safe fallback for circular / non-serializable values. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface AgentToolMeta {
  atlasAgent: AtlasAgent;
  deps: CreateAgentToolDeps;
  toolName: string;
  inputSchema: z.ZodSchema | undefined;
}

/**
 * Rebinds an agent tool to a new writer. Used by the delegate tool so that
 * nested agent calls stream through the delegate proxy instead of leaking
 * to the parent conversation stream.
 */
export function rebindAgentTool(
  tool: AtlasTool,
  writer: UIMessageStreamWriter<AtlasUIMessage>,
): AtlasTool {
  const meta = (tool as Record<symbol, unknown>)[AGENT_TOOL_META] as AgentToolMeta | undefined;
  if (!meta) return tool;

  return createAgentTool(meta.atlasAgent, { ...meta.deps, writer })[meta.toolName] ?? tool;
}

const DefaultPromptInputSchema = z.object({
  prompt: z.string().describe("Natural-language instruction for the agent."),
});

/**
 * Detect whether a Zod schema produces a JSON Schema with `type: "object"` at
 * the root. Anthropic rejects tool input schemas whose root uses `oneOf` /
 * `anyOf` without an explicit `type` (`tools.N.custom.input_schema.type:
 * Field required`), which Zod emits for top-level discriminated unions like
 * the `gh` / `bb` / `jira` deterministic agents. In those cases the agent
 * handler accepts the prompt as a free-form string and parses the JSON
 * itself, so the wrapper falls back to {@link DefaultPromptInputSchema}.
 */
function hasObjectRoot(schema: z.ZodSchema): boolean {
  try {
    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    return json.type === "object";
  } catch {
    return false;
  }
}

/**
 * Wrap a bundled `AtlasAgent` as an AI SDK tool. Returns `{ agent_<id>: tool }`
 * when env requirements are met, or `{}` when any required env key is missing.
 */
export function createAgentTool(atlasAgent: AtlasAgent, deps: CreateAgentToolDeps): AtlasTools {
  const toolName = `agent_${atlasAgent.metadata.id}`;
  const required = atlasAgent.environmentConfig?.required ?? [];
  const missing = required
    .map((field) => field.name)
    .filter((name) => !deps.env[name] || deps.env[name].length === 0);

  if (missing.length > 0) {
    deps.logger.debug(`${toolName} not registered — missing env key ${missing[0]}`, {
      agentId: atlasAgent.metadata.id,
      missing,
    });
    return {};
  }

  const declaredSchema = atlasAgent.metadata.inputSchema;
  const inputSchema =
    declaredSchema && hasObjectRoot(declaredSchema) ? declaredSchema : DefaultPromptInputSchema;

  const toolObj = tool({
    description: atlasAgent.metadata.description,
    inputSchema,
    execute: async (input, { toolCallId }) => {
      const stream = new CallbackStreamEmitter(
        (event) => {
          if (
            typeof event === "object" &&
            event !== null &&
            "toolCallId" in event &&
            typeof event.toolCallId === "string" &&
            event.toolCallId.length > 0
          ) {
            event = { ...event, toolCallId: `${toolCallId}::${event.toolCallId}` };
          }
          // Data events (e.g. data-tool-timing) carry toolCallId inside `data`
          // rather than at the top level — namespace those too so downstream
          // reducers can correlate timing with reconstructed tool calls.
          if (
            typeof event === "object" &&
            event !== null &&
            "data" in event &&
            typeof event.data === "object" &&
            event.data !== null &&
            "toolCallId" in event.data &&
            typeof event.data.toolCallId === "string" &&
            event.data.toolCallId.length > 0
          ) {
            event = {
              ...event,
              data: { ...event.data, toolCallId: `${toolCallId}::${event.data.toolCallId}` },
            };
          }
          deps.writer.write(event);
        },
        () => {},
        (_err) => {},
      );

      const context: AgentContext = {
        tools: deps.tools ?? {},
        session: deps.session,
        env: deps.env,
        stream,
        logger: deps.logger,
        abortSignal: deps.abortSignal,
        platformModels: deps.platformModels,
        memory: deps.memory,
      };

      const payload = await atlasAgent.execute(
        declaredSchema && hasObjectRoot(declaredSchema)
          ? (input as never)
          : (input as { prompt: string }).prompt,
        context,
      );
      if (payload.ok) {
        // Emit structured extras (reasoning, tool history) as data events so
        // the chat UI can display them without depending on the compact result
        // payload that the parent LLM sees.
        if (payload.reasoning && payload.reasoning.length > 0) {
          stream.emit({
            type: "data-tool-progress",
            data: { toolName: atlasAgent.metadata.id, content: payload.reasoning },
          });
        }
        if (payload.toolCalls && payload.toolCalls.length > 0) {
          for (const tc of payload.toolCalls) {
            const resultEntry = payload.toolResults?.find(
              (tr: { toolCallId: string }) => tr.toolCallId === tc.toolCallId,
            );
            stream.emit({
              type: "data-inner-tool-call",
              data: {
                toolName: tc.toolName,
                status: resultEntry ? "completed" : "failed",
                input: safeJson(tc.input),
                result: resultEntry ? safeJson(resultEntry.output) : undefined,
              },
            });
          }
        }
        return payload.data;
      }
      throw new Error(payload.error.reason);
    },
  });

  Object.defineProperty(toolObj, AGENT_TOOL_META, {
    value: {
      atlasAgent,
      deps,
      toolName,
      inputSchema: declaredSchema,
    } satisfies AgentToolMeta,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  return { [toolName]: toolObj };
}
