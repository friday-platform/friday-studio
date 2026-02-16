import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundledAgentsRegistry } from "@atlas/bundled-agents/registry";
import type { ValidatedJSONSchema } from "@atlas/core/artifacts";
import { JSONSchemaSchema } from "@atlas/core/artifacts";
import { getDefaultProviderOpts, registry } from "@atlas/llm";
import { generateText, hasToolCall, stepCountIs, tool } from "ai";
import { wrapAISDKModel } from "evalite/ai-sdk";
import { z } from "zod";
import type { Agent, JobWithDAG, PrepareMapping, WorkspaceBlueprint } from "../types.ts";
import { PrepareMappingSchema, SIGNAL_DOCUMENT_ID } from "../types.ts";
import {
  addConstant,
  addSourceMapping,
  addTransformMapping,
  createMappingAccumulator,
  finalize,
  type MappingAccumulator,
  type MappingContext,
} from "./mapping-accumulator.ts";
import { lookupOutputSchema } from "./tools.ts";
import { ValidationExecutor } from "./validation-executor.ts";

// ---------------------------------------------------------------------------
// Phase 3 sub-phase: Prepare Mapping Generation (tool-use)
// ---------------------------------------------------------------------------

/**
 * Resolve the consumer agent's input JSON schema from the bundled agent registry.
 * Returns undefined for LLM agents (no input schema validation).
 */
function resolveConsumerInputSchema(
  plan: WorkspaceBlueprint,
  consumerStepId: string,
): ValidatedJSONSchema | undefined {
  // Find the consumer step's agent ID
  for (const job of plan.jobs) {
    const step = job.steps.find((s) => s.id === consumerStepId);
    if (!step) continue;

    const registryEntry = bundledAgentsRegistry[step.agentId];
    if (registryEntry?.inputJsonSchema) {
      return JSONSchemaSchema.parse(registryEntry.inputJsonSchema);
    }
    return undefined;
  }
  return undefined;
}

/**
 * Build AI SDK tool wrappers that close over the plan context and accumulator.
 *
 * Tools: lookupOutputSchema (read-only), addSourceMapping, addConstant, finalize.
 * Each add-tool validates inputs against ground truth schemas before accepting.
 * The accumulator collects successful operations; rejected ones are returned
 * with actionable error details.
 */
function buildMappingTools(
  plan: WorkspaceBlueprint,
  stepOutputSchemas: Map<string, ValidatedJSONSchema>,
  sourceStepId: string,
  consumerStepId: string,
  executor: ValidationExecutor,
): { tools: ReturnType<typeof _buildTools>; accumulator: MappingAccumulator } {
  const accumulator = createMappingAccumulator();

  const ctx: MappingContext = {
    plan,
    stepOutputSchemas,
    sourceDocId: `${sourceStepId}-output`,
    sourceStepId,
    consumerStepId,
    consumerInputSchema: resolveConsumerInputSchema(plan, consumerStepId),
    executor,
  };

  const tools = _buildTools(accumulator, ctx, plan, stepOutputSchemas);
  return { tools, accumulator };
}

/** Internal: create the AI SDK tool definitions. Separated for return type inference. */
function _buildTools(
  acc: MappingAccumulator,
  ctx: MappingContext,
  plan: WorkspaceBlueprint,
  stepOutputSchemas: Map<string, ValidatedJSONSchema>,
) {
  return {
    lookupOutputSchema: tool({
      description:
        "Look up the output JSON schema for a step. Returns the schema " +
        "with all available fields, or an error if the step is not found.",
      inputSchema: z.object({ stepId: z.string().describe("The step ID to look up") }),
      execute: ({ stepId }) => {
        return lookupOutputSchema(stepId, { plan, stepOutputSchemas });
      },
    }),

    addSourceMapping: tool({
      description:
        "Add a source field mapping. Validates fromPath against the source " +
        "step's output schema and toField against the consumer's input schema " +
        "(when available). Returns { accepted: true } or { accepted: false, " +
        "error, available } with actionable details.",
      inputSchema: z.object({
        fromDoc: z.string().describe("Source document ID"),
        fromPath: z
          .string()
          .describe("Dot-path to the source field (e.g., 'summary', 'queries[].sql')"),
        toField: z.string().describe("Target field name in the consumer's input"),
      }),
      execute: (input) => {
        return addSourceMapping(acc, ctx, input);
      },
    }),

    addTransformMapping: tool({
      description:
        "Add a transform mapping. Extracts a source field, applies a JavaScript " +
        "expression, and maps the result to the consumer's input. The expression " +
        "receives `value` (extracted field) and `docs` (all upstream documents " +
        "keyed by document ID). Validates: source path, target field, expression " +
        "syntax, execution against mock data, and result type (bundled agents). " +
        "Returns { accepted: true } or rejection with error, mock data snapshot, " +
        "and available field suggestions.",
      inputSchema: z.object({
        fromDoc: z.string().describe("Source document ID"),
        fromPath: z.string().describe("Dot-path to the source field"),
        toField: z.string().describe("Target field name in the consumer's input"),
        transform: z
          .string()
          .describe(
            "JavaScript expression with `value` and `docs` bindings. " +
              "Single expression, no statements. Example: `value.reduce((sum, i) => sum + i.amount, 0)`",
          ),
        description: z.string().describe("Human-readable explanation of the transform"),
      }),
      execute: (input) => {
        return addTransformMapping(acc, ctx, input);
      },
    }),

    addConstant: tool({
      description:
        "Add a constant value to the mapping. When the consumer is a bundled " +
        "agent, validates the key exists in the consumer's input schema and " +
        "the value matches the expected type. Returns { accepted: true } or " +
        "{ accepted: false, error }.",
      inputSchema: z.object({
        key: z.string().describe("Target field name"),
        value: z.unknown().describe("Constant value to inject"),
      }),
      execute: (input) => {
        return addConstant(acc, ctx, input);
      },
    }),

    finalize: tool({
      description:
        "Signal that you are done adding mappings. Takes no arguments. " +
        "Returns a summary of the accumulated mapping.",
      inputSchema: z.object({}),
      execute: () => {
        return finalize(acc);
      },
    }),
  };
}

/**
 * Build the system prompt for prepare mapping generation.
 *
 * For fan-in steps we make one LLM call per upstream dependency,
 * so `upstreamStep` is the single source the LLM should wire.
 */
export function buildMappingPrompt(
  step: JobWithDAG["steps"][number],
  upstreamStep: JobWithDAG["steps"][number],
  job: JobWithDAG,
  agents: Agent[],
): string {
  const allUpstream = job.steps.filter((s) => step.depends_on.includes(s.id));

  // Provide full context about all upstream steps so the LLM can
  // reason about what THIS mapping should carry vs what siblings handle.
  const contextBlock =
    allUpstream.length > 1
      ? `\n\n## Context\n\nThis step fans-in from ${allUpstream.length} upstream steps: ${allUpstream.map((s) => `"${s.id}"`).join(", ")}.\nYou are generating the mapping for the "${upstreamStep.id}" source ONLY.`
      : "";

  const consumerAgent = agents.find((a) => a.id === step.agentId);
  const agentBlock = consumerAgent
    ? `\n\n## Consumer Agent\n\nAgent "${consumerAgent.name}" (${consumerAgent.id}): ${consumerAgent.description}${
        consumerAgent.configuration && Object.keys(consumerAgent.configuration).length > 0
          ? `\n\nAgent configuration:\n${JSON.stringify(consumerAgent.configuration, null, 2)}\n\nEach key-value pair in this configuration MUST be included as a constant in the mapping via addConstant.`
          : ""
      }`
    : "";

  return `You generate prepare mappings that wire data between DAG steps by building them incrementally through validated tool calls.

## Your Task

Generate a prepare mapping for step "${step.id}" (agent: ${step.agentId})
sourcing data from upstream step "${upstreamStep.id}" (agent: ${upstreamStep.agentId}).

Upstream step description: ${upstreamStep.description}${contextBlock}${agentBlock}

## Workflow

1. Call lookupOutputSchema for "${upstreamStep.id}" to see available fields
2. For each field the consumer needs from this upstream:
   a. Call addSourceMapping for plain field extraction (from a dot-path to a target field)
   b. Call addTransformMapping when the field needs computation, reshaping, or cross-document derivation
3. Call addConstant for any constant values the consumer needs (agent configuration, static parameters)
4. If a tool call is rejected, read the error and available fields to self-correct, then retry
5. Call finalize when all mappings are added

Every addSourceMapping and addTransformMapping call validates the path against the source schema. Invalid paths are rejected with available field suggestions — use them to self-correct.

## Array Mapping Rule

When mapping an array field, choose ONE approach:
- Map the full array (e.g., fromPath "items") to pass all element fields, OR
- Map individual element fields (e.g., fromPath "items[].name", "items[].price") to extract specific sub-arrays.

NEVER do both. Mapping the full array AND individual element projections creates redundant data.

## Schema Fidelity Rule

Transform expressions MUST only access properties that exist in the source schema. When you call lookupOutputSchema, examine the schema carefully — including nested object properties inside array items. If an array's items schema defines { name, title }, you can ONLY access .name and .title on those items. Do NOT assume or invent fields (like .email, .id, .url) that are not present in the schema. If the data you need does not exist in the schema, it cannot be extracted — do not write a transform that references nonexistent fields.

## When to Use Transforms

Transforms handle structural wiring between agents: reshaping data, computing derived values that no single agent produces, and assembling inputs from multiple sources. If you're tempted to filter, summarize, format, or reprocess an agent's output — that work belongs in the agent's step description, not a transform. A transform should never duplicate or second-guess what an agent is designed to do.

Good transform uses:
- Structural reshaping: pulling specific fields into the shape a downstream agent expects
- Cross-document derivation: computing values from multiple upstream outputs (e.g., combining a tax rate from one step with line items from another)
- Format bridging: converting between data representations when schemas don't align structurally

Bad transform uses:
- Filtering or summarizing an agent's natural language output
- Duplicating computation the agent should perform
- Compensating for a vague step description
- Accessing fields that do not exist in the source schema (e.g., mapping contact.email when items only have name and title)

## Completing Your Task

Do NOT output JSON as text. Build the mapping through tool calls only. Call finalize when done.`;
}

/**
 * Log tool call traces for a step to disk.
 * Includes tool calls/results grouped by step boundary, plus the LLM's
 * final text response for debugging when tool extraction fails.
 */
async function logToolTraces(
  runDir: string,
  stepId: string,
  // Use unknown[] to avoid coupling to the generic ToolSet parameter
  steps: Array<{ toolCalls: unknown[]; toolResults: unknown[]; text: string }>,
  finalText: string,
): Promise<void> {
  const traceDir = join(runDir, "phase3-traces");
  await mkdir(traceDir, { recursive: true });

  const traces = steps.flatMap((s, stepIndex) =>
    s.toolCalls.map((tc, i) => ({ stepIndex, index: i, toolCall: tc, result: s.toolResults[i] })),
  );

  const output = { traces, finalText: finalText || undefined };

  await writeFile(join(traceDir, `${stepId}.json`), JSON.stringify(output, null, 2));
}

/**
 * Generate deterministic prepare mappings from trigger signal → root steps.
 *
 * Root steps have no upstream dependencies — their input comes from the
 * trigger signal payload. Each signal schema property maps 1:1 to a config
 * field. No LLM call needed; signals arrive in the user-defined shape.
 */
function generateSignalMappings(
  rootSteps: JobWithDAG["steps"],
  job: JobWithDAG,
  plan: WorkspaceBlueprint,
): PrepareMapping[] {
  const signal = plan.signals.find((s) => s.id === job.triggerSignalId);
  const properties = (signal?.payloadSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  if (!properties || Object.keys(properties).length === 0) return [];

  return rootSteps.map((step) =>
    PrepareMappingSchema.parse({
      consumerStepId: step.id,
      documentId: SIGNAL_DOCUMENT_ID,
      documentType: "trigger-signal",
      sources: Object.keys(properties).map((field) => ({ from: field, to: field })),
      constants: [],
    }),
  );
}

/**
 * Generate prepare mappings for all steps in a job.
 *
 * Root steps get deterministic signal → step mappings (no LLM call).
 * Non-root steps get LLM-generated step → step mappings, one call per
 * upstream dependency. For fan-in steps (depends_on.length > 1) this
 * produces one mapping per upstream source, all parallelized via Promise.all.
 */
export async function generatePrepareMappings(
  job: JobWithDAG,
  plan: WorkspaceBlueprint,
  stepOutputSchemas: Map<string, ValidatedJSONSchema>,
  options: { verbose?: boolean; runDir?: string } = {},
): Promise<PrepareMapping[]> {
  const rootSteps = job.steps.filter((s) => s.depends_on.length === 0);
  const nonRootSteps = job.steps.filter((s) => s.depends_on.length > 0);

  // Deterministic signal → root step mappings (no LLM call)
  const signalMappings = generateSignalMappings(rootSteps, job, plan);

  // Build one task per (consumer step, upstream step) pair
  const tasks: Array<{
    step: JobWithDAG["steps"][number];
    upstreamStep: JobWithDAG["steps"][number];
  }> = [];

  for (const step of nonRootSteps) {
    for (const depId of step.depends_on) {
      const upstreamStep = job.steps.find((s) => s.id === depId);
      if (!upstreamStep) {
        throw new Error(
          `Step "${step.id}" depends on "${depId}" which doesn't exist in job "${job.id}"`,
        );
      }
      tasks.push({ step, upstreamStep });
    }
  }

  // Long-lived executor shared across all mapping tasks, disposed at end
  const executor = new ValidationExecutor();

  try {
    const results = await Promise.all(
      tasks.map(async ({ step, upstreamStep }) => {
        const traceId = `${step.id}--from-${upstreamStep.id}`;

        // Each (consumer, upstream) pair gets its own accumulator
        const { tools, accumulator } = buildMappingTools(
          plan,
          stepOutputSchemas,
          upstreamStep.id,
          step.id,
          executor,
        );

        const result = await generateText({
          model: wrapAISDKModel(registry.languageModel("anthropic:claude-sonnet-4-5")),
          tools,
          stopWhen: [stepCountIs(10), hasToolCall("finalize")],
          messages: [
            {
              role: "system",
              content: buildMappingPrompt(step, upstreamStep, job, plan.agents),
              providerOptions: getDefaultProviderOpts("anthropic"),
            },
            {
              role: "user",
              content: `Generate the prepare mapping for step "${step.id}" sourcing from "${upstreamStep.id}".`,
            },
          ],
          maxOutputTokens: 4_096,
        });

        // Log tool traces in verbose mode
        if (options.verbose && options.runDir) {
          await logToolTraces(options.runDir, traceId, result.steps, result.text);
        }

        // Build the mapping from the accumulator
        return PrepareMappingSchema.parse({
          consumerStepId: step.id,
          documentId: `${upstreamStep.id}-output`,
          documentType: "output",
          sources: accumulator.sources,
          constants: accumulator.constants,
        });
      }),
    );

    return [...signalMappings, ...results];
  } finally {
    executor.dispose();
  }
}
