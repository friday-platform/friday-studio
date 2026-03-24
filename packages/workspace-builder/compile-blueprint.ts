/**
 * Compiles a WorkspaceBlueprint into a workspace.yml YAML string.
 *
 * Pure function — no I/O, no LLM calls. Same input always produces same output.
 * Dynamic MCP servers are the only optional external input (passed as param).
 */

import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { stringifyError } from "@atlas/utils";
import { buildWorkspaceYaml } from "./assembler/build-workspace.ts";
import type { CompileWarning } from "./compiler/build-fsm.ts";
import { buildFSMFromPlan } from "./compiler/build-fsm.ts";
import { PipelineError } from "./planner/build-blueprint.ts";
import type { WorkspaceBlueprint } from "./types.ts";
import { ClassifiedDAGStepSchema } from "./types.ts";

export type CompileBlueprintResult = { ok: true; yaml: string } | { ok: false; error: string };

/**
 * Compiles a WorkspaceBlueprint into a workspace.yml YAML string.
 *
 * Iterates each job in the blueprint, parses steps through ClassifiedDAGStepSchema,
 * compiles FSMs via `buildFSMFromPlan`, and assembles the final YAML via
 * `buildWorkspaceYaml`. Returns a discriminated result — no exceptions thrown.
 */
export function compileBlueprint(
  blueprint: WorkspaceBlueprint,
  dynamicServers?: MCPServerMetadata[],
): CompileBlueprintResult {
  try {
    const fsms = [];

    for (const job of blueprint.jobs) {
      const classifiedJob = {
        ...job,
        steps: job.steps.map((s) => ClassifiedDAGStepSchema.parse(s)),
      };

      const result = buildFSMFromPlan(classifiedJob);
      if (!result.success) {
        return {
          ok: false,
          error: `FSM compilation failed for job '${job.id}': ${JSON.stringify(result.error)}`,
        };
      }

      if (result.value.warnings.length > 0) {
        const warningMessages = result.value.warnings
          .map((w: CompileWarning) => `  ${w.type}: ${w.message}`)
          .join("\n");
        throw new PipelineError(
          "compile",
          new Error(`Compiler warnings for job '${job.id}':\n${warningMessages}`),
        );
      }

      fsms.push(result.value.fsm);
    }

    const yaml = buildWorkspaceYaml(
      { workspace: blueprint.workspace, signals: blueprint.signals, agents: blueprint.agents },
      blueprint,
      fsms,
      blueprint.credentialBindings,
      dynamicServers,
    );

    return { ok: true, yaml };
  } catch (error: unknown) {
    if (error instanceof PipelineError) {
      return {
        ok: false,
        error: `Compilation failed at "${error.phase}": ${error.cause?.message}`,
      };
    }
    return { ok: false, error: stringifyError(error) };
  }
}
