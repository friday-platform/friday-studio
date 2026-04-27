/**
 * Upsert tools for workspace-chat.
 *
 * Allows the workspace-chat agent to upsert agents, signals, and jobs into
 * a workspace configuration. Each tool respects draft mode: if a draft exists,
 * the change is staged there; otherwise it writes directly to the live config.
 *
 * Every tool returns `{ ok, diff, structural_issues }` so the LLM can confirm
 * intent before proceeding.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { client } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";
import { jsonSchema, tool } from "ai";

export interface FieldDiff {
  [field: string]: { from?: unknown; to?: unknown } | { added?: unknown[]; removed?: unknown[] };
}

export interface UpsertResult {
  ok: boolean;
  diff: FieldDiff;
  structural_issues: Array<{ code: string; path: string; message: string }> | null;
  error?: string;
}

const UPSERT_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    id: {
      type: "string" as const,
      description: "Unique identifier for the entity (kebab-case recommended)",
    },
    config: {
      type: "object" as const,
      description:
        "Entity configuration object. Must match the schema for the target kind. " +
        "For agents: { type, description, config: { provider, model, prompt, ... } }. " +
        "For signals: { provider, description, config: { ... } }. " +
        "For jobs: { description, triggers, fsm | execution }.",
      additionalProperties: true,
    },
  },
  required: ["id", "config"],
};

function makePlaceholder(kind: string) {
  return tool({
    description: `Upsert a ${kind} into the current workspace. Respects draft mode.`,
    inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
    execute: async () => ({
      ok: false,
      diff: {} as FieldDiff,
      structural_issues: null,
      error:
        `upsert_${kind} must be called with a workspaceId context. ` +
        "This is handled automatically by the workspace-chat agent.",
    }),
  });
}

export function createUpsertTools(_logger: Logger): AtlasTools {
  return {
    upsert_agent: makePlaceholder("agent"),
    upsert_signal: makePlaceholder("signal"),
    upsert_job: makePlaceholder("job"),
  };
}

/**
 * Build upsert tools bound to a specific workspaceId.
 *
 * The unbound versions above are placeholders for tool registration;
 * the agent handler calls this factory with the real workspaceId
 * and replaces the execute functions with workspace-scoped HTTP calls.
 */
export function createBoundUpsertTools(logger: Logger, workspaceId: string): AtlasTools {
  async function executeUpsert(
    kind: "agent" | "signal" | "job",
    id: string,
    config: Record<string, unknown>,
  ): Promise<UpsertResult> {
    logger.info(`upsert_${kind} tool invoked`, { workspaceId, id });

    // Try the draft endpoint first.
    const draftRes = await client.workspace[":workspaceId"].draft.items[":kind"].$post({
      param: { workspaceId, kind },
      json: { id, config },
    });

    if (!draftRes.ok && draftRes.status === 409) {
      // No draft exists — fall back to the direct (live) endpoint.
      logger.info(`No draft for workspace ${workspaceId}, falling back to direct ${kind} upsert`);
      const directRes = await client.workspace[":workspaceId"].items[":kind"].$post({
        param: { workspaceId, kind },
        json: { id, config },
      });

      if (!directRes.ok) {
        const body = await directRes.json().catch(() => ({ error: `Direct ${kind} upsert failed` }));
        logger.warn(`Direct ${kind} upsert failed`, { workspaceId, id, error: body.error });
        return {
          ok: false,
          diff: {},
          structural_issues: null,
          error: body.error ?? `Direct ${kind} upsert failed`,
        };
      }

      const body = await directRes.json();
      logger.info(`Direct ${kind} upsert succeeded`, { workspaceId, id });
      return {
        ok: body.ok,
        diff: body.diff ?? {},
        structural_issues: body.structuralIssues ?? body.structural_issues ?? null,
      };
    }

    if (!draftRes.ok) {
      const body = await draftRes.json().catch(() => ({ error: `Draft ${kind} upsert failed` }));
      logger.warn(`Draft ${kind} upsert failed`, { workspaceId, id, error: body.error });
      return {
        ok: false,
        diff: {},
        structural_issues: null,
        error: body.error ?? `Draft ${kind} upsert failed`,
      };
    }

    const body = await draftRes.json();
    logger.info(`Draft ${kind} upsert succeeded`, { workspaceId, id });
    return {
      ok: body.ok,
      diff: body.diff ?? {},
      structural_issues: body.structuralIssues ?? body.structural_issues ?? null,
    };
  }

  return {
    upsert_agent: tool({
      description:
        "Upsert an agent into the current workspace. " +
        "If a draft exists, the agent is staged in the draft; otherwise it writes directly to the live workspace.yml. " +
        "Returns `{ ok, diff, structural_issues }` so you can confirm what changed before publishing.",
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      execute: async ({ id, config }: { id: string; config: Record<string, unknown> }) =>
        executeUpsert("agent", id, config),
    }),

    upsert_signal: tool({
      description:
        "Upsert a signal into the current workspace. " +
        "If a draft exists, the signal is staged in the draft; otherwise it writes directly to the live workspace.yml. " +
        "Returns `{ ok, diff, structural_issues }` so you can confirm what changed before publishing.",
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      execute: async ({ id, config }: { id: string; config: Record<string, unknown> }) =>
        executeUpsert("signal", id, config),
    }),

    upsert_job: tool({
      description:
        "Upsert a job into the current workspace. " +
        "If a draft exists, the job is staged in the draft; otherwise it writes directly to the live workspace.yml. " +
        "Returns `{ ok, diff, structural_issues }` so you can confirm what changed before publishing.",
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      execute: async ({ id, config }: { id: string; config: Record<string, unknown> }) =>
        executeUpsert("job", id, config),
    }),
  };
}
