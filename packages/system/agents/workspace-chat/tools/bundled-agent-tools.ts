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

  return {
    [toolName]: tool({
      description: atlasAgent.metadata.description,
      inputSchema,
      execute: async (input) => {
        const stream = new CallbackStreamEmitter(
          (event) => deps.writer.write(event),
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

        const payload = await atlasAgent.execute(input, context);
        if (payload.ok) {
          return payload.data;
        }
        throw new Error(payload.error.reason);
      },
    }),
  };
}
