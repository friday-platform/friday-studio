/**
 * Direct MCP executor for FSM execution harness.
 *
 * Runs agents in-process using MCPManager + AI SDK generateText.
 * Fully decoupled from the daemon — spins up MCP server connections
 * directly, injects a `complete` tool for structured output capture,
 * and returns AgentResult envelopes.
 *
 * @module
 */

import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { AgentAction, AgentResult, Context, SignalWithContext } from "@atlas/fsm-engine";
import { registry, traceModel } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { MCPManager } from "@atlas/mcp";
import type { WorkspaceBlueprint } from "@atlas/workspace-builder";
import { generateText, stepCountIs, type Tool } from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Builds the agent prompt from an action and FSM context.
 *
 * When `fsmContext.input` is present, an "Input:" section is rendered.
 * No Documents section — prepare functions curate what the agent needs.
 *
 * @param action - The agent action containing prompt and agentId
 * @param fsmContext - The FSM context with optional input
 * @returns The assembled prompt string
 */
export function buildAgentPrompt(action: AgentAction, fsmContext: Context): string {
  const base = action.prompt ?? `Execute task step for agent "${action.agentId}".`;

  if (fsmContext.input) {
    return `${base}\n\nInput:\n${JSON.stringify(fsmContext.input, null, 2)}`;
  }

  return base;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Model ID in `provider:model` format accepted by the @atlas/llm registry. */
type RegistryModelId =
  | `anthropic:${string}`
  | `google:${string}`
  | `groq:${string}`
  | `openai:${string}`;

export interface DirectExecutorOptions {
  plan: WorkspaceBlueprint;
  /** Model ID (default: anthropic:claude-sonnet-4-6) */
  model?: RegistryModelId;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates an AgentExecutor that runs agents directly with MCP tools.
 *
 * For each agent action:
 * 1. Looks up agent's MCP servers in plan
 * 2. Registers servers with MCPManager (resolves Link credentials automatically)
 * 3. Gets AI SDK tools from the MCP servers
 * 4. Injects a `complete` tool using the output schema from document contracts
 * 5. Runs generateText agentic loop
 * 6. Extracts structured output from the `complete` tool call
 */
export function createDirectMCPExecutor(opts: DirectExecutorOptions): {
  executor: (
    action: AgentAction,
    context: Context,
    signal: SignalWithContext,
  ) => Promise<AgentResult>;
  shutdown: () => Promise<void>;
} {
  const { plan, model: modelId = "anthropic:claude-sonnet-4-6" } = opts;
  const mcpManager = new MCPManager();
  const registeredServers = new Set<string>();

  // Lookups
  const agentMap = new Map(plan.agents.map((a) => [a.id, a]));
  const schemaByOutputTo = new Map<string, Record<string, unknown>>();
  for (const job of plan.jobs) {
    for (const contract of job.documentContracts) {
      schemaByOutputTo.set(contract.documentId, contract.schema);
    }
  }

  const executor = async (
    action: AgentAction,
    fsmContext: Context,
    _signal: SignalWithContext,
  ): Promise<AgentResult> => {
    const startTime = Date.now();
    const agent = agentMap.get(action.agentId);

    if (!agent) {
      return {
        ok: false,
        agentId: action.agentId,
        timestamp: new Date().toISOString(),
        input: fsmContext.input ?? {},
        error: { reason: `Agent "${action.agentId}" not found in plan` },
        durationMs: Date.now() - startTime,
      };
    }

    // Register MCP servers lazily (once per server)
    const serverIds: string[] = [];
    if (agent.mcpServers?.length) {
      for (const serverRef of agent.mcpServers) {
        serverIds.push(serverRef.serverId);
        if (registeredServers.has(serverRef.serverId)) continue;

        const serverMeta = mcpServersRegistry.servers[serverRef.serverId];
        if (!serverMeta) {
          throw new Error(`Unknown MCP server in registry: ${serverRef.serverId}`);
        }

        logger.info("Registering MCP server for direct execution", {
          serverId: serverRef.serverId,
          transport: serverMeta.configTemplate.transport.type,
        });

        await mcpManager.registerServer({ id: serverRef.serverId, ...serverMeta.configTemplate });
        registeredServers.add(serverRef.serverId);
      }
    }

    // Get MCP tools
    const mcpTools: Record<string, Tool> =
      serverIds.length > 0 ? await mcpManager.getToolsForServers(serverIds) : {};

    // Inject `complete` tool if we have an output schema (same pattern as FSMEngine).
    // We capture args via the execute callback because AI SDK step.toolCalls
    // exposes `input` not `args`, and the execute callback receives the
    // Zod-validated object directly.
    let completeToolInjected = false;
    let capturedCompleteArgs: unknown;
    const allTools: Record<string, Tool> = { ...mcpTools };

    if (action.outputTo) {
      const jsonSchema = schemaByOutputTo.get(action.outputTo);
      if (jsonSchema?.properties && Object.keys(jsonSchema.properties).length > 0) {
        const zodSchema = z.fromJSONSchema(jsonSchema);
        allTools.complete = {
          description:
            "Call this to complete the task and store results. You MUST call this when finished.",
          inputSchema: zodSchema,
          execute: (args: unknown) => {
            capturedCompleteArgs = args;
            return { success: true };
          },
        };
        completeToolInjected = true;
      }
    }

    // Build prompt
    const basePrompt = buildAgentPrompt(action, fsmContext);
    const completeSuffix = completeToolInjected
      ? "\n\nIMPORTANT: When you have finished gathering information, you MUST call the `complete` tool to store your structured results. " +
        "Do NOT just respond with text — call the `complete` tool with the data."
      : "";
    const prompt = basePrompt + completeSuffix;

    logger.info("Running direct agent execution", {
      agentId: action.agentId,
      mcpServers: serverIds,
      toolCount: Object.keys(allTools).length,
      hasCompleteSchema: completeToolInjected,
    });

    // Agentic loop
    const result = await generateText({
      model: traceModel(registry.languageModel(modelId)),
      system: `You are ${agent.name}. ${agent.description}\n\nYou have access to tools. Use them to accomplish your task.`,
      prompt,
      tools: allTools,
      stopWhen: stepCountIs(50),
    });

    // Log execution trace per step
    for (let i = 0; i < result.steps.length; i++) {
      const step = result.steps[i];
      if (!step) continue;
      const calls = (step.toolCalls ?? []).map((tc) => tc.toolName);
      const results = (step.toolResults ?? []).map((tr) => ({
        tool: tr.toolName,
        resultLength: tr.output != null ? JSON.stringify(tr.output).length : 0,
      }));
      logger.info(`Direct execution step ${i + 1}/${result.steps.length}`, {
        agentId: action.agentId,
        toolCalls: calls,
        toolResults: results,
        finishReason: step.finishReason,
        textLength: step.text?.length ?? 0,
      });
    }
    const toolCallNames = result.steps.flatMap((s) => (s.toolCalls ?? []).map((tc) => tc.toolName));
    logger.info("Direct agent execution completed", {
      agentId: action.agentId,
      steps: result.steps.length,
      toolCalls: toolCallNames,
      finishReason: result.finishReason,
      textLength: result.text.length,
    });

    // Extract structured output from `complete` tool call
    let data: unknown;
    if (completeToolInjected) {
      if (capturedCompleteArgs !== undefined) {
        data = capturedCompleteArgs;
      } else {
        logger.warn("Agent did not call complete tool — falling back to text parsing", {
          agentId: action.agentId,
          toolCallsMade: toolCallNames,
        });
      }
    }

    // Fallback: try parsing text as JSON, then wrap as text
    if (data === undefined && result.text) {
      try {
        data = JSON.parse(result.text);
      } catch {
        data = { text: result.text };
      }
    }

    data ??= {};

    return {
      ok: true as const,
      agentId: action.agentId,
      timestamp: new Date().toISOString(),
      input: fsmContext.input ?? {},
      data,
      durationMs: Date.now() - startTime,
    };
  };

  const shutdown = async () => {
    for (const serverId of registeredServers) {
      try {
        await mcpManager.closeServer(serverId);
      } catch {
        // best-effort cleanup
      }
    }
  };

  return { executor, shutdown };
}
