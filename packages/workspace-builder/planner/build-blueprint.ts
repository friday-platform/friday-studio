/**
 * Pipeline orchestrator: prompt -> WorkspaceBlueprint.
 *
 * Sequences all planner steps internally so consumer shells (workspace-planner,
 * do-task, proto CLI) call one function instead of replicating ~250 lines of
 * step wiring.
 */

import type { ValidatedJSONSchema } from "@atlas/core/artifacts";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import type { Logger } from "@atlas/logger";
import type { CredentialBinding, ResourceDeclaration } from "@atlas/schemas/workspace";
import { ResourceDeclarationSchema } from "@atlas/schemas/workspace";
import type { DocumentContract, WorkspaceBlueprint } from "../types.ts";

import type { AgentClarification, ConfigRequirement } from "./classify-agents.ts";
import { classifyAgents } from "./classify-agents.ts";
import { generateDAGSteps } from "./dag.ts";
import { enrichAgentsWithPipelineContext } from "./enrich-pipeline-context.ts";
import { enrichSignals } from "./enrich-signals.ts";
import { generatePrepareMappings } from "./mappings.ts";
import { generatePlan, type Phase1Result, type PlanMode } from "./plan.ts";
import { checkEnvironmentReadiness, type ReadinessResult } from "./preflight.ts";
import { resolveCredentials, type UnresolvedCredential } from "./resolve-credentials.ts";
import { generateOutputSchemas } from "./schemas.ts";
import { stampExecutionTypes } from "./stamp-execution-types.ts";
import { validateResourceSchemas } from "./validate-resource-schemas.ts";

export type { FieldCheck, ReadinessCheck, ReadinessResult } from "./preflight.ts";
export type {
  ResolveCredentialsOpts,
  UnresolvedCredential,
} from "./resolve-credentials.ts";
// Re-export extracted types so existing consumers keep working
export type { CredentialBinding };

// ---------------------------------------------------------------------------
// PipelineError
// ---------------------------------------------------------------------------

/**
 * Thrown when a pipeline step fails unrecoverably.
 *
 * Wraps the underlying cause with pipeline context so callers can produce
 * meaningful error messages (e.g., "dag step failed: cycle detected").
 */
export class PipelineError extends Error {
  /** Step that failed (e.g., "plan", "dag", "schemas"). */
  readonly phase: string;
  declare readonly cause: Error;

  constructor(phase: string, cause: Error) {
    super(`Pipeline failed at "${phase}": ${cause.message}`);
    this.name = "PipelineError";
    this.phase = phase;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Options & Result
// ---------------------------------------------------------------------------

/** Options for buildBlueprint(). */
export type BuildBlueprintOpts = {
  /** "workspace" includes signal planning; "task" excludes it. */
  mode: PlanMode;
  /** Contextual logger instance. */
  logger: Logger;
  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal;
  /** Pre-computed plan + classify results — skips those steps when provided. */
  precomputed?: {
    plan: Phase1Result;
    classified: { clarifications: AgentClarification[]; configRequirements: ConfigRequirement[] };
  };
};

/** Result from buildBlueprint(). */
export type BlueprintResult = {
  blueprint: WorkspaceBlueprint;
  clarifications: AgentClarification[];
  credentials: { bindings: CredentialBinding[]; unresolved: UnresolvedCredential[] };
  readiness: ReadinessResult;
  /** Runtime-registered MCP servers from KV used during classification. */
  dynamicServers: MCPServerMetadata[];
};

// ---------------------------------------------------------------------------
// Step runner — logs inputs/outputs and wraps failures in PipelineError
// ---------------------------------------------------------------------------

/**
 * Run a pipeline step with structured logging and error wrapping.
 *
 * @param phase - Human-readable step name for logging/errors.
 * @param work - The actual work to perform.
 * @param opts.logger - Logger instance.
 * @param opts.inputs - Structured data logged at step start.
 * @param opts.logOutputs - Optional function to pick fields from the result for logging.
 * @param opts.abortSignal - Abort signal for cancellation.
 */
async function runStep<T>(
  phase: string,
  work: () => T | Promise<T>,
  opts: {
    logger: Logger;
    inputs: Record<string, unknown>;
    logOutputs?: (result: T) => Record<string, unknown>;
    abortSignal?: AbortSignal;
  },
): Promise<T> {
  // Check abort before starting
  if (opts.abortSignal?.aborted) {
    throw opts.abortSignal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }

  try {
    opts.logger.info(`Starting step: ${phase}`, opts.inputs);
    const result = await work();
    const outputs = opts.logOutputs?.(result) ?? {};
    opts.logger.info(`Completed step: ${phase}`, outputs);
    return result;
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    const error = err instanceof Error ? err : new Error(String(err));
    if (error.name === "AbortError") throw error;
    throw new PipelineError(phase, error);
  }
}

// ---------------------------------------------------------------------------
// buildBlueprint
// ---------------------------------------------------------------------------

/**
 * Orchestrate the full planner pipeline.
 *
 * @throws {PipelineError} On unrecoverable step failure.
 * @throws {DOMException} AbortError when the provided AbortSignal fires.
 */
export async function buildBlueprint(
  prompt: string,
  opts: BuildBlueprintOpts,
): Promise<BlueprintResult> {
  const { mode, logger, abortSignal, precomputed } = opts;

  // -- plan ----------------------------------------------------------------
  const phase1 = precomputed
    ? precomputed.plan
    : await runStep("plan", () => generatePlan(prompt, { mode, abortSignal }), {
        logger,
        abortSignal,
        inputs: { prompt, mode },
        logOutputs: (r) => ({
          workspace: r.workspace.name,
          signals: r.signals.length,
          agents: r.agents.length,
        }),
      });

  // Reuse dynamic servers already fetched during planning (avoids redundant KV lookup)
  const dynamicServers = phase1.dynamicServers;

  // -- classify ------------------------------------------------------------
  const { clarifications, configRequirements } = precomputed
    ? precomputed.classified
    : await runStep("classify", () => classifyAgents(phase1.agents, { dynamicServers }), {
        logger,
        abortSignal,
        inputs: { agentCount: phase1.agents.length, dynamicServerCount: dynamicServers.length },
        logOutputs: (r) => ({
          clarifications: r.clarifications.length,
          configRequirements: r.configRequirements.length,
        }),
      });

  // -- credentials ---------------------------------------------------------
  let credentialBindings: CredentialBinding[] = [];
  let unresolvedCredentials: UnresolvedCredential[] = [];

  if (configRequirements.length > 0) {
    const credResult = await runStep("credentials", () => resolveCredentials(configRequirements), {
      logger,
      abortSignal,
      inputs: { configRequirements: configRequirements.length },
      logOutputs: (r) => ({ resolved: r.bindings.length, unresolved: r.unresolved.length }),
    });
    credentialBindings = credResult.bindings;
    unresolvedCredentials = credResult.unresolved;
  }

  // -- preflight -----------------------------------------------------------
  let readiness: ReadinessResult = {
    ready: true,
    checks: [],
    summary: { present: 0, missing: 0, skipped: 0, resolved: 0 },
  };

  if (configRequirements.length > 0) {
    readiness = await runStep(
      "preflight",
      () => checkEnvironmentReadiness(configRequirements, credentialBindings),
      {
        logger,
        abortSignal,
        inputs: { configRequirements: configRequirements.length },
        logOutputs: (r) => ({ ready: r.ready }),
      },
    );
  }

  // -- signals (workspace mode only) ---------------------------------------
  if (mode === "workspace" && phase1.signals.length > 0) {
    phase1.signals = await runStep(
      "signals",
      () => enrichSignals(phase1.signals, { abortSignal }),
      {
        logger,
        abortSignal,
        inputs: { signalCount: phase1.signals.length },
        logOutputs: (r) => ({ enriched: r.filter((s) => s.signalConfig).length }),
      },
    );
  }

  // -- dag -----------------------------------------------------------------
  const rawJobs = await runStep(
    "dag",
    () => generateDAGSteps(prompt, phase1.signals, phase1.agents),
    {
      logger,
      abortSignal,
      inputs: { prompt, signalCount: phase1.signals.length, agentCount: phase1.agents.length },
      logOutputs: (r) => ({
        jobCount: r.length,
        totalSteps: r.reduce((sum, j) => sum + j.steps.length, 0),
      }),
    },
  );

  // -- stamp execution types -----------------------------------------------
  const jobs = await runStep("stamp", () => stampExecutionTypes(rawJobs, phase1.agents), {
    logger,
    abortSignal,
    inputs: { jobCount: rawJobs.length, agentCount: phase1.agents.length },
    logOutputs: (r) => ({
      bundled: r.reduce(
        (n, j) => n + j.steps.filter((s) => s.executionType === "bundled").length,
        0,
      ),
      llm: r.reduce((n, j) => n + j.steps.filter((s) => s.executionType === "llm").length, 0),
    }),
  });

  // -- parse resources early (needed for enrichment and validation) --------
  const parsedResources: ResourceDeclaration[] =
    phase1.resources.length > 0
      ? phase1.resources.map((r) => ResourceDeclarationSchema.parse(r))
      : [];

  // -- context (pipeline enrichment) ---------------------------------------
  await runStep(
    "context",
    () =>
      enrichAgentsWithPipelineContext(phase1.agents, jobs, {
        resources: parsedResources.length > 0 ? parsedResources : undefined,
      }),
    {
      logger,
      abortSignal,
      inputs: { agentCount: phase1.agents.length, jobCount: jobs.length },
      logOutputs: (r) => ({ entriesCount: r.entries.length }),
    },
  );

  // -- per-job: schemas, completeness gate, contracts ----------------------
  for (const job of jobs) {
    const jobSchemas = await runStep(
      `schemas/${job.id}`,
      () => generateOutputSchemas(job.steps, phase1.agents),
      {
        logger,
        abortSignal,
        inputs: { jobId: job.id, stepCount: job.steps.length },
        logOutputs: (r) => ({ schemaCount: r.size }),
      },
    );

    // Completeness gate — retry missing schemas once
    const missingSteps = job.steps.filter((s) => !jobSchemas.has(s.id));
    if (missingSteps.length > 0) {
      logger.warn("Contract completeness gate: missing schemas, retrying", {
        jobId: job.id,
        missingStepIds: missingSteps.map((s) => s.id),
      });

      const retrySchemas = await runStep(
        `schemas-retry/${job.id}`,
        () => generateOutputSchemas(missingSteps, phase1.agents),
        {
          logger,
          abortSignal,
          inputs: { jobId: job.id, missingCount: missingSteps.length },
          logOutputs: (r) => ({ schemaCount: r.size }),
        },
      );

      for (const [stepId, schema] of retrySchemas) {
        jobSchemas.set(stepId, schema);
      }

      const stillMissing = missingSteps.filter((s) => !jobSchemas.has(s.id));
      if (stillMissing.length > 0) {
        throw new PipelineError(
          "contract-completeness",
          new Error(
            `Steps missing output schemas after retry: ${stillMissing.map((s) => s.id).join(", ")}`,
          ),
        );
      }
    }

    // Build document contracts from schemas
    const contracts: DocumentContract[] = [];
    for (const step of job.steps) {
      const schema = jobSchemas.get(step.id);
      if (schema) {
        contracts.push({
          producerStepId: step.id,
          documentId: `${step.id}-output`,
          documentType: `${step.id}-result`,
          schema,
        });
      }
    }
    job.documentContracts = contracts;
  }

  // -- resource schemas (only when resources are declared) -----------------
  if (parsedResources.length > 0) {
    await runStep("resource-schemas", () => validateResourceSchemas(parsedResources), {
      logger,
      abortSignal,
      inputs: { resourceCount: parsedResources.length },
    });
  }

  // -- assemble blueprint (needed for mappings) ----------------------------
  const blueprint: WorkspaceBlueprint = {
    workspace: phase1.workspace,
    signals: phase1.signals,
    agents: phase1.agents,
    jobs,
    ...(parsedResources.length > 0 ? { resources: parsedResources } : {}),
  };

  // -- mappings (per-job) --------------------------------------------------
  for (const job of jobs) {
    // Re-derive schemas from contracts — they were just built above
    const jobSchemas = new Map<string, ValidatedJSONSchema>();
    for (const contract of job.documentContracts) {
      jobSchemas.set(contract.producerStepId, contract.schema);
    }

    const mappings = await runStep(
      `mappings/${job.id}`,
      () => generatePrepareMappings(job, blueprint, jobSchemas),
      {
        logger,
        abortSignal,
        inputs: { jobId: job.id, stepCount: job.steps.length },
        logOutputs: (r) => ({ mappingCount: r.length }),
      },
    );
    job.prepareMappings = mappings;
  }

  return {
    blueprint,
    clarifications,
    credentials: { bindings: credentialBindings, unresolved: unresolvedCredentials },
    readiness,
    dynamicServers,
  };
}
