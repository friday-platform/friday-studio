import type { ValidatedJSONSchema } from "@atlas/core/artifacts";
import type { WorkspaceBlueprint } from "../types.ts";

// ---------------------------------------------------------------------------
// lookupOutputSchema — returns the JSON schema for a step's output
// ---------------------------------------------------------------------------

type LookupContext = {
  plan: WorkspaceBlueprint;
  stepOutputSchemas: Map<string, ValidatedJSONSchema>;
};

type LookupOutputSchemaResult = { schema: ValidatedJSONSchema } | { error: string };

/**
 * Find the agent ID for a step by searching all jobs in the plan.
 */
function findAgentIdForStep(plan: WorkspaceBlueprint, stepId: string): string | undefined {
  for (const job of plan.jobs) {
    const step = job.steps.find((s) => s.id === stepId);
    if (step) return step.agentId;
  }
  return undefined;
}

/**
 * Return the JSON schema for a step's output from the stepOutputSchemas map.
 */
export function lookupOutputSchema(
  stepId: string,
  context: LookupContext,
): LookupOutputSchemaResult {
  const agentId = findAgentIdForStep(context.plan, stepId);
  if (!agentId) {
    return { error: `Step "${stepId}" not found in plan` };
  }

  const schema = context.stepOutputSchemas.get(stepId);
  if (schema) {
    return { schema };
  }

  return { error: `No output schema available for step "${stepId}" (agent "${agentId}")` };
}
