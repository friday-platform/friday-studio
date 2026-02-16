/**
 * Mock agent executor for FSM execution harness.
 *
 * Plugs into FSMEngine's `agentExecutor` callback. Resolves stub data
 * from an override map or falls back to schema-derived stubs, then
 * wraps the result in a valid AgentResult envelope.
 *
 * @module
 */

import type { ValidatedJSONSchema } from "@atlas/core/artifacts";
import type { AgentAction, AgentResult, Context, SignalWithContext } from "@atlas/fsm-engine";
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
  const { plan, agentOverrides = {} } = opts;

  // Build a lookup from documentId → schema for O(1) access
  const schemaByDocId = new Map<string, ValidatedJSONSchema>();
  for (const job of plan.jobs) {
    for (const contract of job.documentContracts) {
      schemaByDocId.set(contract.documentId, contract.schema);
    }
  }

  return (
    action: AgentAction,
    _context: Context,
    _signal: SignalWithContext,
  ): Promise<AgentResult> => {
    const outputTo = action.outputTo;

    let data: unknown;
    if (outputTo && outputTo in agentOverrides) {
      data = agentOverrides[outputTo];
    } else if (outputTo) {
      data = resolveFromSchema(outputTo, schemaByDocId);
    } else {
      data = {};
    }

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

/** Falls back to schema-derived stub or empty object. */
function resolveFromSchema(
  outputTo: string,
  schemaByDocId: Map<string, ValidatedJSONSchema>,
): unknown {
  const schema = schemaByDocId.get(outputTo);
  if (schema) {
    return generateStubFromSchema(schema);
  }
  return {};
}
