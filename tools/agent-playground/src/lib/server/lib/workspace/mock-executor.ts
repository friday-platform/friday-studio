/**
 * Mock executors for FSM execution harness.
 *
 * Provides mock implementations of both `AgentExecutor` and `LLMProvider`
 * for deterministic FSM simulation without real agents or LLM calls.
 *
 * Both resolve stub data from an override map or fall back to
 * schema-derived stubs, wrapping results in the expected envelopes.
 *
 * @module
 */

import type { ValidatedJSONSchema } from "@atlas/core/artifacts";
import type {
  AgentAction,
  AgentResult,
  Context,
  FSMLLMOutput,
  LLMProvider,
  SignalWithContext,
} from "@atlas/fsm-engine";
import { generateStubFromSchema, type WorkspaceBlueprint } from "@atlas/workspace-builder";

/**
 * Options for creating a mock agent executor.
 *
 * @param plan - The compiled plan with contracts (used for schema lookup)
 * @param agentOverrides - Map from documentId to override data (takes priority over schema stubs)
 */
export interface MockExecutorOptions {
  plan: WorkspaceBlueprint;
  agentOverrides?: Record<string, unknown>;
}

/**
 * Creates an AgentExecutor-compatible function that returns deterministic mock data.
 *
 * Resolution order:
 * 1. `agentOverrides[action.outputTo]` — programmatic override (highest priority)
 * 2. Schema-derived stub from document contract matching `action.outputTo`
 * 3. Empty object `{}` — fallback when no contract exists
 *
 * @param opts - Mock executor options
 * @returns An async function matching the AgentExecutor signature
 */
export function createMockAgentExecutor(opts: MockExecutorOptions) {
  const { agentOverrides = {} } = opts;
  const schemaByDocId = buildSchemaLookup(opts.plan);

  return (
    action: AgentAction,
    _context: Context,
    _signal: SignalWithContext,
  ): Promise<AgentResult> => {
    const data = resolveStubData(action.outputTo, schemaByDocId, agentOverrides);

    return Promise.resolve({
      ok: true as const,
      agentId: action.agentId,
      timestamp: new Date().toISOString(),
      input: {},
      data,
      durationMs: 0,
    });
  };
}

/**
 * Creates a mock LLMProvider for deterministic FSM simulation.
 *
 * Resolves stub data using the same schema lookup as the agent executor.
 * Returns results with a `complete` tool call so FSMEngine's
 * `findCompleteToolArgs` extracts the structured data.
 *
 * @param opts - Mock executor options (same as agent executor)
 * @returns An LLMProvider with a mock `call` method
 */
export function createMockLLMProvider(opts: MockExecutorOptions): LLMProvider {
  const { agentOverrides = {} } = opts;
  const schemaByDocId = buildSchemaLookup(opts.plan);

  return {
    call(params) {
      // Extract outputTo from agentId (format: "fsm:<definition-id>:<outputTo>")
      const outputTo = params.agentId.split(":").at(-1);
      const stubData = resolveStubData(outputTo, schemaByDocId, agentOverrides) as Record<
        string,
        unknown
      >;

      const hasCompleteTool = params.tools !== undefined && "complete" in params.tools;

      const result: AgentResult<string, FSMLLMOutput> = {
        ok: true as const,
        agentId: params.agentId,
        timestamp: new Date().toISOString(),
        input: params.prompt,
        data: stubData,
        toolCalls: hasCompleteTool
          ? [
              {
                type: "tool-call" as const,
                toolCallId: "mock-complete",
                toolName: "complete",
                input: stubData,
              },
            ]
          : [],
        durationMs: 0,
      };

      return Promise.resolve(result);
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Builds a documentId to JSON Schema lookup from all jobs in the plan. */
function buildSchemaLookup(plan: WorkspaceBlueprint): Map<string, ValidatedJSONSchema> {
  const lookup = new Map<string, ValidatedJSONSchema>();
  for (const job of plan.jobs) {
    for (const contract of job.documentContracts) {
      lookup.set(contract.documentId, contract.schema);
    }
  }
  return lookup;
}

/** Resolves stub data from overrides, schema, or empty fallback. */
function resolveStubData(
  outputTo: string | undefined,
  schemaByDocId: Map<string, ValidatedJSONSchema>,
  overrides: Record<string, unknown>,
): unknown {
  if (outputTo && outputTo in overrides) {
    return overrides[outputTo];
  }
  if (outputTo) {
    const schema = schemaByDocId.get(outputTo);
    return schema ? generateStubFromSchema(schema) : {};
  }
  return {};
}
