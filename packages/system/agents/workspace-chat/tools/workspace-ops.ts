/**
 * Workspace-creation tool for workspace-chat.
 *
 * Collapses the 10+ bash/curl round-trips Friday does via the workspace-api skill
 * into a single typed tool call. Friday plans the config in one LLM turn, hands
 * the JSON to `workspace_create`, and gets back either `{ id }` on success or
 * `{ errors }` on validation failure (for one-turn retry).
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";
import { jsonSchema, tool } from "ai";

const WORKSPACE_CREATE_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    config: {
      type: "object" as const,
      description:
        "Full workspace configuration (the object that would live inside workspace.yml). " +
        "Must include a top-level `workspace: { name, description, ... }` block plus " +
        "any `signals`, `jobs`, `agents`, `mcp_servers`, `resources`, `memory`, `models` " +
        "that the workspace needs. The daemon validates this against the real schema " +
        "and the reference-validator (catches hallucinated npm packages, typoed agent " +
        "ids, bad FSM transitions, etc.) before persisting.",
      additionalProperties: true,
    },
    workspaceName: {
      type: "string" as const,
      description:
        "Optional kebab-case directory name. Defaults to a slugified version of " +
        "config.workspace.name. Conflicts auto-resolve with -2, -3 suffixes.",
    },
  },
  required: ["config"],
};

export function createWorkspaceOpsTools(logger: Logger): AtlasTools {
  return {
    workspace_create: tool({
      description:
        "Create a new workspace from a full config object in a single call. " +
        "Prefer this over shelling out to curl/HTTP — it runs the same validator " +
        "and returns structured errors you can fix in one retry. On 422 the " +
        "response contains a `report.issues[]` array with `code`, `path`, `message` " +
        "for each problem (e.g. npm_package_not_found, unknown_agent_id, " +
        "fsm_structural_error). Fix every issue and retry with an updated config.\n\n" +
        "FSM shape (XState-style, the only shape the validator accepts): each " +
        "state is either `{ entry: [...actions], on: { EVENT: { target: 'next-state' } } }` " +
        "or `{ type: 'final' }`. Actions: `{type: agent, agentId, outputTo, outputType, prompt}`, " +
        "`{type: code, function: 'fnName'}`, `{type: emit, event: EVENT_NAME}`. " +
        "Do NOT use `type: action, action: {...}, next: ...` — that's the legacy " +
        "shape and it fails with fsm_structural_error. Agent states typically end " +
        "with `- type: emit, event: ADVANCE` and route via `on.ADVANCE.target`.",
      inputSchema: jsonSchema(WORKSPACE_CREATE_INPUT_SCHEMA),
      execute: async (input: Record<string, unknown>) => {
        const config = input.config as Record<string, unknown>;
        const workspaceName =
          typeof input.workspaceName === "string" ? input.workspaceName : undefined;

        logger.info("workspace_create tool invoked", { workspaceName, hasConfig: !!config });

        const result = await parseResult(
          client.workspace.create.$post({ json: { config, workspaceName, ephemeral: false } }),
        );

        if (!result.ok) {
          logger.warn("workspace_create failed", { error: result.error });
          // parseResult unwraps 4xx/5xx into result.error — for 422 the payload
          // is a structured ValidationReport that the LLM should fix.
          return { success: false, error: result.error };
        }

        logger.info("workspace_create succeeded");
        // result.data shape: { success, workspace: {id,name,path,...}, workspacePath, filesCreated, ... }
        // Pass it through opaquely — the LLM only needs success + whatever context it finds useful.
        return { success: true, result: result.data };
      },
    }),
  };
}
