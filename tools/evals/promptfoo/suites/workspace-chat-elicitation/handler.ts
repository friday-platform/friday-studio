// Deno handler for the workspace-chat-elicitation promptfoo suite.
//
// Migrated from tools/evals/agents/workspace-chat/elicitation-behavior.eval.ts.
// The original ran Haiku-only via the custom Deno harness; this handler is
// driven by promptfoo so the same cases run across the full friday-* tier
// matrix.
//
// Imports the real workspace-chat system prompt + the real @atlas/llm
// provider registry (which transparently routes through the LiteLLM proxy
// when LITELLM_API_KEY is set). NO daemon is spawned — we reproduce the
// LLM-facing surface (real system prompt + real tool descriptions) with
// fake tool implementations that capture the model's decisions.
//
// The per-case `request_tool_access` response shape comes from
// `vars.toolResponseJson` (parsed from a JSON string), so each test row can
// switch between the bypass / pending-approval branches.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildRegistryModelId, isRegistryProvider, registry } from "@atlas/llm";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

const ROOT = resolve(import.meta.dirname ?? ".", "../../../../..");
const WORKSPACE_CHAT_PROMPT = await readFile(
  resolve(ROOT, "packages/system/agents/workspace-chat/prompt.txt"),
  "utf8",
);

interface ResponseShape {
  ok: boolean;
  granted: boolean;
  reason: string;
  elicitationId?: string;
}

interface Captures {
  requestToolAccessCalls: Array<{ toolName: string; reason: string }>;
  secretToolCalls: Array<{ args: unknown }>;
}

function buildTools(captures: Captures, response: ResponseShape) {
  return {
    request_tool_access: tool({
      description:
        "Request permission to call a tool not in your allowlist. Returns " +
        "either { ok: true, granted: true, reason: 'bypass' } when the job " +
        "has dangerouslySkipAllowlist set, or { ok: false, granted: false, " +
        "elicitationId, reason: 'pending_user_approval' } otherwise.",
      inputSchema: z.object({ toolName: z.string(), reason: z.string() }),
      // deno-lint-ignore require-await
      execute: async ({ toolName, reason }) => {
        captures.requestToolAccessCalls.push({ toolName, reason });
        return response;
      },
    }),

    secret_tool: tool({
      description: "Underlying tool the LLM was trying to call.",
      inputSchema: z.object({ payload: z.string().optional() }),
      // deno-lint-ignore require-await
      execute: async ({ payload }) => {
        captures.secretToolCalls.push({ args: { payload } });
        return { ok: true, result: "secret-tool-stub" };
      },
    }),
  };
}

interface Request {
  prompt: string;
  vars: { toolResponseJson?: string } & Record<string, unknown>;
  config: { registryId?: string } & Record<string, unknown>;
}

export default async function handle(req: Request): Promise<{ output: string; cost?: number }> {
  if (!req.config.registryId) {
    throw new Error("workspace-chat-elicitation: providerConfig.registryId is required");
  }
  if (!req.vars.toolResponseJson) {
    throw new Error("workspace-chat-elicitation: vars.toolResponseJson is required");
  }

  const response = JSON.parse(req.vars.toolResponseJson) as ResponseShape;
  const captures: Captures = { requestToolAccessCalls: [], secretToolCalls: [] };
  const tools = buildTools(captures, response);

  const colon = req.config.registryId.indexOf(":");
  if (colon < 0) {
    throw new Error(`registryId must be 'provider:model', got: ${req.config.registryId}`);
  }
  const providerId = req.config.registryId.slice(0, colon);
  const modelId = req.config.registryId.slice(colon + 1);
  if (!isRegistryProvider(providerId)) {
    throw new Error(`Unknown provider in registryId '${req.config.registryId}'`);
  }
  const typedId = buildRegistryModelId(providerId, modelId);

  const result = streamText({
    model: registry.languageModel(typedId),
    system: WORKSPACE_CHAT_PROMPT,
    messages: [{ role: "user", content: req.prompt }],
    tools,
    temperature: 0,
    stopWhen: stepCountIs(6),
  });

  let text = "";
  for await (const chunk of result.fullStream) {
    if (chunk.type === "error") {
      throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error));
    }
    if (chunk.type === "text-delta") {
      const delta =
        (chunk as { textDelta?: string; text?: string }).textDelta ??
        (chunk as { text?: string }).text ??
        "";
      text += delta;
    }
  }

  // LiteLLM emits per-request USD cost in a header rather than the OpenAI-shaped
  // JSON body. Versions ≥ ~1.86 use `x-litellm-response-cost-original` (with
  // companion `-discount-amount`/`-margin-*` variants); earlier versions used a
  // flat `x-litellm-response-cost`. Check both so the bridge keeps working
  // across upstream upgrades. The AI SDK exposes HTTP response headers on
  // `result.response.headers` for any HTTP-based provider that talks to
  // LiteLLM. Forward to deno-worker.cjs which surfaces it as top-level `cost`
  // on the promptfoo ProviderResponse.
  const responseMeta = await result.response;
  const costHeader = responseMeta.headers?.["x-litellm-response-cost-original"] ??
    responseMeta.headers?.["x-litellm-response-cost"];
  const cost = costHeader && !Number.isNaN(Number(costHeader)) ? Number(costHeader) : undefined;

  return { output: JSON.stringify({ text, captures }), cost };
}
