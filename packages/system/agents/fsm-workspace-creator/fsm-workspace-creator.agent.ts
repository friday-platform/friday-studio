/**
 * FSM Workspace Creator Agent (v2.0 - LLM Code Generation)
 *
 * Generates FSM definitions from WorkspacePlan artifacts using LLM-powered code generation.
 * Replaces template-based generation with dynamic TypeScript code execution.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createAgent } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { type WorkspacePlan, WorkspacePlanSchema } from "@atlas/core/artifacts";
import { type ValidatedFSMDefinition, validateFSMStructure } from "@atlas/fsm-engine";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { executeCodegen } from "@atlas/workspace-builder";
import { toKebabCase } from "@std/text";
import { stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import { classifyAgents } from "./agent-classifier.ts";
import { flattenAgent } from "./agent-helpers.ts";
import { generateMCPServers } from "./enrichers/mcp-servers.ts";
import { enrichSignal } from "./enrichers/signals.ts";
import { generateFSMCode } from "./fsm-generation-core.ts";
import { buildWorkspaceConfig } from "./workspace-config-builder.ts";

type FSMCreatorResult = Result<
  {
    workspacePath: string;
    jobCount: number;
    metadata: {
      generatedCode: Record<string, string>; // jobId -> generated TypeScript code
      codegenAttempts: Record<string, number>; // jobId -> number of attempts
    };
  },
  { reason: string }
>;

const FSMCreatorInputSchema = z.object({
  artifactId: z.string().describe("WorkspacePlan artifact ID"),
  workspacePath: z
    .string()
    .optional()
    .describe("Path to workspace directory (default: current directory)"),
});

type FSMCreatorInput = z.infer<typeof FSMCreatorInputSchema>;

/**
 * FSM Workspace Creator Agent v2.0
 *
 * Uses LLM to generate TypeScript code with FSMBuilder API instead of templates.
 * Supports multiple jobs with one FSM per job.
 */
export const fsmWorkspaceCreatorAgent = createAgent<FSMCreatorInput, FSMCreatorResult>({
  id: "fsm-workspace-creator",
  displayName: "FSM Workspace Creator",
  version: "2.0.0",
  description:
    "Generates FSM definitions from workspace plans using LLM code generation. " +
    "Creates workspace.yml with validated FSM definitions for each job.",

  expertise: {
    domains: ["FSM generation", "Code generation", "Workflow automation", "State machines"],
    examples: [],
  },

  inputSchema: FSMCreatorInputSchema,

  handler: async (input, { logger, stream, abortSignal }) => {
    logger.info("Starting FSM generation from workspace plan", { artifactId: input.artifactId });

    try {
      // 1. Load workspace plan
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "FSM Creator", content: "Loading workspace plan" },
      });

      const plan = await loadWorkspacePlan(input.artifactId);

      logger.info("Loaded workspace plan", {
        signals: plan.signals.length,
        agents: plan.agents.length,
        jobs: plan.jobs.length,
      });

      // Validate plan has jobs
      if (!plan.jobs || plan.jobs.length === 0) {
        return fail({ reason: "WorkspacePlan must have at least one job" });
      }

      // Check for duplicate job IDs
      const jobIds = new Set<string>();
      for (const job of plan.jobs) {
        if (jobIds.has(job.id)) {
          return fail({ reason: `Duplicate job ID found: ${job.id}` });
        }
        jobIds.add(job.id);
      }

      // Validate agent IDs (kebab-case only)
      for (const agent of plan.agents) {
        if (!/^[a-z][a-z0-9-]*$/.test(agent.id)) {
          return fail({
            reason: `Invalid agent ID '${agent.id}': must be lowercase kebab-case (a-z, 0-9, hyphens only)`,
          });
        }
      }

      // 2. Enrich signals (prose → workspace.yml configs)
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "FSM Creator", content: "Enriching signal configurations" },
      });

      const enrichedSignals = await Promise.all(
        plan.signals.map((s) => enrichSignal(s, abortSignal)),
      );

      logger.info("Signal enrichment complete", { count: enrichedSignals.length });

      // 3. Generate MCP server configs from agent needs
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "FSM Creator", content: "Generating MCP server configurations" },
      });

      const mcpServers = generateMCPServers(plan.agents);

      logger.info("MCP generation complete", {
        count: mcpServers.length,
        servers: mcpServers.map((s) => s.id),
      });

      // 4. Classify agents (bundled vs LLM)
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "FSM Creator", content: "Classifying agents" },
      });

      const agents = classifyAgents(plan);

      logger.info("Agent classification complete", {
        count: agents.length,
        bundled: agents.filter((a) => a.type.kind === "bundled").length,
        llm: agents.filter((a) => a.type.kind === "llm").length,
      });

      // 5. MULTI-JOB LOOP: Generate FSM for each job
      const fsms = new Map<string, ValidatedFSMDefinition>();
      const generatedCodeMap: Record<string, string> = {}; // Track generated code for debugging
      const codegenAttemptsMap: Record<string, number> = {}; // Track codegen attempts

      for (const job of plan.jobs) {
        logger.info(`Generating FSM for job: ${job.id}`);

        stream?.emit({
          type: "data-tool-progress",
          data: { toolName: "FSM Creator", content: `Generating FSM for job: ${job.name}` },
        });

        // Check for duplicate (defensive)
        if (fsms.has(job.id)) {
          return fail({ reason: `Duplicate job ID: ${job.id}` });
        }

        // Filter and flatten agents for this job
        const jobAgents = agents
          .filter((a) => job.steps.some((s) => s.agentId === a.id))
          .map(flattenAgent);

        const triggerSignal = plan.signals.find((s) => s.id === job.triggerSignalId);
        if (!triggerSignal) {
          return fail({
            reason: `Job '${job.id}' references unknown trigger signal '${job.triggerSignalId}'`,
          });
        }

        // Generate TypeScript code via LLM
        logger.info(`Generating builder code via LLM for job: ${job.id}`);

        const generatedCode = await generateFSMCode(
          job,
          jobAgents,
          triggerSignal,
          triggerSignal.payloadSchema,
          abortSignal,
        );

        logger.info(`Generated ${generatedCode.length} chars of builder code for job: ${job.id}`);

        // Save generated code for debugging
        generatedCodeMap[job.id] = generatedCode;
        codegenAttemptsMap[job.id] = 1; // Track attempts (for future retry logic)

        // Execute code via Worker-based codegen (no imports needed - APIs injected in worker scope)
        const codegenResult = await executeCodegen({ code: generatedCode, timeout: 30000 });

        if (!codegenResult.success) {
          logger.error("Codegen execution failed", { jobId: job.id, error: codegenResult.error });
          logger.error("Failed code saved in generatedCodeMap", {
            jobId: job.id,
            codeLength: generatedCode.length,
          });

          return fail({
            reason: `Failed to execute generated code for job '${job.id}': ${codegenResult.error.message}`,
          });
        }

        const buildResult = codegenResult.result;

        if (!buildResult.success) {
          logger.error("FSM build failed", { jobId: job.id, errors: buildResult.error });

          return fail({
            reason: `FSM build failed for job '${job.id}': ${JSON.stringify(
              buildResult.error,
              null,
              2,
            )}`,
          });
        }

        const fsm = buildResult.value;

        // Validate FSM structure
        const validationResult = validateFSMStructure(fsm);
        if (!validationResult.valid) {
          logger.error("FSM validation failed", { jobId: job.id, errors: validationResult.errors });

          return fail({
            reason: `FSM validation failed for job '${job.id}':\n${validationResult.errors.join(
              "\n",
            )}`,
          });
        }

        logger.info("FSM validated successfully", {
          jobId: job.id,
          fsmId: fsm.id,
          stateCount: Object.keys(fsm.states).length,
        });

        // Store validated FSM
        fsms.set(job.id, fsm);
      }

      logger.info("All FSMs generated successfully", { count: fsms.size });

      // 6. Build workspace config with all FSMs
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "FSM Creator", content: "Building workspace configuration" },
      });

      const workspaceConfig = buildWorkspaceConfig(plan, enrichedSignals, mcpServers, fsms);

      // 7. Save to disk
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "FSM Creator", content: "Saving workspace file" },
      });

      const workspaceName = toKebabCase(plan.workspace.name);
      const workspacePath = input.workspacePath || `./${workspaceName}`;
      await mkdir(workspacePath, { recursive: true });

      const workspaceYml = stringifyYaml(workspaceConfig);
      const ymlPath = `${workspacePath}/workspace.yml`;

      await writeFile(ymlPath, workspaceYml, "utf-8");

      // Register workspace with daemon
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "FSM Creator", content: "Registering workspace with daemon" },
      });

      const absoluteWorkspacePath = await Deno.realPath(workspacePath);
      const registrationResponse = await parseResult(
        client.workspace.add.$post({
          json: {
            path: absoluteWorkspacePath,
            name: plan.workspace.name,
            description: plan.workspace.purpose,
          },
        }),
      );

      if (!registrationResponse.ok) {
        logger.error("Failed to register workspace", {
          path: absoluteWorkspacePath,
          error: registrationResponse.error,
        });
        return fail({
          reason: `Workspace files created but registration failed: ${stringifyError(
            registrationResponse.error,
          )}`,
        });
      }

      logger.info("Workspace generation and registration complete", {
        workspacePath,
        workspaceId: registrationResponse.data.id,
        ymlPath,
        signals: enrichedSignals.length,
        mcpServers: mcpServers.length,
        jobCount: plan.jobs.length,
        totalStates: Array.from(fsms.values()).reduce(
          (sum, fsm) => sum + Object.keys(fsm.states).length,
          0,
        ),
      });

      return success({
        workspacePath: ymlPath,
        jobCount: plan.jobs.length,
        metadata: { generatedCode: generatedCodeMap, codegenAttempts: codegenAttemptsMap },
      });
    } catch (error) {
      logger.error("FSM creation failed", { error: stringifyError(error) });
      return fail({ reason: stringifyError(error) });
    }
  },
});

/**
 * Load workspace plan artifact from storage
 */
async function loadWorkspacePlan(artifactId: string): Promise<WorkspacePlan> {
  const response = await parseResult(
    client.artifactsStorage[":id"].$get({ param: { id: artifactId } }),
  );

  if (!response.ok || response.data.artifact.type !== "workspace-plan") {
    throw new Error("Failed to load workspace plan artifact");
  }

  const artifactData = response.data.artifact.data;
  if (typeof artifactData.data === "string") {
    throw new Error("Unexpected string data in workspace plan artifact");
  }

  // Validate with Zod schema
  const validationResult = WorkspacePlanSchema.safeParse(artifactData.data);
  if (!validationResult.success) {
    throw new Error(`Invalid workspace plan data: ${validationResult.error.message}`);
  }

  return validationResult.data;
}
