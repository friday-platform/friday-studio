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
import { z } from "zod";

const StructuralIssueSchema = z.object({ code: z.string(), path: z.string(), message: z.string() });

const FieldDiffEntrySchema = z.object({
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  added: z.array(z.unknown()).optional(),
  removed: z.array(z.unknown()).optional(),
});

const FieldDiffSchema = z.record(z.string(), FieldDiffEntrySchema);

const UpsertErrorBodySchema = z.object({
  error: z.string().optional(),
  diff: FieldDiffSchema.optional(),
  structuralIssues: z.array(StructuralIssueSchema).nullable().optional(),
  structural_issues: z.array(StructuralIssueSchema).nullable().optional(),
});

type UpsertErrorBody = z.infer<typeof UpsertErrorBodySchema>;

function parseStructuralIssues(
  body: UpsertErrorBody,
): Array<{ code: string; path: string; message: string }> | null {
  return body.structuralIssues ?? body.structural_issues ?? null;
}

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
    workspaceId: {
      type: "string" as const,
      description:
        "Optional. Target a specific workspace instead of the current session workspace. Pass the workspace id returned by create_workspace.",
    },
  },
  required: ["id", "config"],
};

function makePlaceholder(kind: string) {
  return tool({
    description: `Upsert a ${kind} into the current workspace. Respects draft mode.`,
    inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
    execute: () =>
      Promise.resolve({
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
    upsert_memory_own: makePlaceholder("memory-own"),
    upsert_memory_mount: makePlaceholder("memory-mount"),
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
    kind: "agent" | "signal" | "job" | "memory-own" | "memory-mount",
    id: string,
    config: Record<string, unknown>,
    targetWorkspaceId: string,
  ): Promise<UpsertResult> {
    logger.info(`upsert_${kind} tool invoked`, { workspaceId: targetWorkspaceId, id });

    // Try the draft endpoint first.
    const draftRes = await client.workspace[":workspaceId"].draft.items[":kind"].$post({
      param: { workspaceId: targetWorkspaceId, kind },
      json: { id, config },
    });

    if (!draftRes.ok && draftRes.status === 409) {
      // No draft exists — fall back to the direct (live) endpoint.
      logger.info(
        `No draft for workspace ${targetWorkspaceId}, falling back to direct ${kind} upsert`,
      );
      const directRes = await client.workspace[":workspaceId"].items[":kind"].$post({
        param: { workspaceId: targetWorkspaceId, kind },
        json: { id, config },
      });

      if (!directRes.ok) {
        let body: UpsertErrorBody;
        try {
          body = UpsertErrorBodySchema.parse(await directRes.json());
        } catch {
          body = { error: `Direct ${kind} upsert failed` };
        }
        const structuralIssues = parseStructuralIssues(body);
        const hasStructuredIssues = structuralIssues !== null && structuralIssues.length > 0;
        logger.warn(`Direct ${kind} upsert failed`, {
          workspaceId: targetWorkspaceId,
          id,
          error: body.error,
          structuralIssuesCount: hasStructuredIssues ? structuralIssues.length : 0,
        });
        return {
          ok: false,
          diff: body.diff ?? {},
          structural_issues: structuralIssues,
          error:
            body.error ??
            (hasStructuredIssues ? "Validation failed" : `Direct ${kind} upsert failed`),
        };
      }

      const body = await directRes.json();
      logger.info(`Direct ${kind} upsert succeeded`, { workspaceId: targetWorkspaceId, id });
      return {
        ok: body.ok,
        diff: body.diff ?? {},
        structural_issues: body.structural_issues ?? null,
      };
    }

    if (!draftRes.ok) {
      let body: UpsertErrorBody;
      try {
        body = UpsertErrorBodySchema.parse(await draftRes.json());
      } catch {
        body = { error: `Draft ${kind} upsert failed` };
      }
      logger.warn(`Draft ${kind} upsert failed`, {
        workspaceId: targetWorkspaceId,
        id,
        error: body.error,
      });
      return {
        ok: false,
        diff: {},
        structural_issues: null,
        error: body.error ?? `Draft ${kind} upsert failed`,
      };
    }

    const body = await draftRes.json();
    logger.info(`Draft ${kind} upsert succeeded`, { workspaceId: targetWorkspaceId, id });
    return {
      ok: body.ok,
      diff: body.diff ?? {},
      structural_issues: body.structural_issues ?? null,
    };
  }

  return {
    upsert_agent: tool({
      description:
        "Upsert an agent into the current workspace's draft (or live config if no draft). " +
        "The `config` field's shape depends on `config.type`:\n\n" +
        '- `type: "llm"` — inline LLM agent. Shape: ' +
        "`{ type, description, config: { provider, model, prompt, tools? } }`. " +
        'Use when the work is open-ended ("figure out what to do") and no bundled agent fits.\n' +
        '- `type: "atlas"` — bundled platform agent (web, slack, gh, etc.). Shape: ' +
        "`{ type, agent, description, prompt, config?, env? }`. " +
        "Does not accept a `tools` array — the bundled agent is a self-contained black box and " +
        "does NOT invoke MCP tools. Each atlas agent is tightly scope-limited — some are " +
        "outbound-only (e.g. message senders), some are read-only (e.g. scrapers), and none " +
        "maintain authenticated session state across calls. " +
        "Before picking `type: atlas`, call `list_capabilities` and verify the agent's " +
        "`constraints` field covers the user's intent end-to-end. If the user's task crosses " +
        "a constraint — mutating state the agent only reads, needing a specific MCP tool, or " +
        'operating on a provider the agent does not ship support for — use `type: "llm"` ' +
        "with the right MCP server enabled instead. The `prompt` is task-specific context " +
        "layered on the agent's bundled behavior — describe the user's intent, not the mechanics.\n" +
        '- `type: "user"` — registered Python/TS SDK code agent. Shape: ' +
        "`{ type, agent, prompt?, env? }`. " +
        "Use ONLY when the per-call decision is mechanical: regex/schema validation, " +
        "deterministic routing table, format conversion, fixed dispatch. " +
        "If the agent calls `ctx.llm.generate` to make any decision (classifying, " +
        'summarizing, choosing among options, scoring confidence), use `type: "llm"` ' +
        "instead — the LLM judgment belongs in an inline llm agent with MCP tools, " +
        "not buried inside Python. See `writing-friday-python-agents` skill.\n\n" +
        "Returns `{ ok, diff, structural_issues }` so you can confirm what changed before publishing. " +
        "Pass `workspaceId` to target a workspace other than the current session.",
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      execute: ({
        id,
        config,
        workspaceId: providedId,
      }: {
        id: string;
        config: Record<string, unknown>;
        workspaceId?: string;
      }) => executeUpsert("agent", id, config, providedId ?? workspaceId),
    }),

    upsert_signal: tool({
      description:
        "Upsert a signal into the current workspace. " +
        "If a draft exists, the signal is staged in the draft; otherwise it writes directly to the live workspace.yml. " +
        "Returns `{ ok, diff, structural_issues }` so you can confirm what changed before publishing. " +
        "Optional: pass workspaceId to target a different workspace (e.g. after create_workspace).",
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      execute: ({
        id,
        config,
        workspaceId: providedId,
      }: {
        id: string;
        config: Record<string, unknown>;
        workspaceId?: string;
      }) => executeUpsert("signal", id, config, providedId ?? workspaceId),
    }),

    upsert_job: tool({
      description:
        "Upsert a job into the current workspace. " +
        "If a draft exists, the job is staged in the draft; otherwise it writes directly to the live workspace.yml. " +
        "Returns `{ ok, diff, structural_issues }` so you can confirm what changed before publishing. " +
        "Optional: pass workspaceId to target a different workspace (e.g. after create_workspace).",
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      execute: ({
        id,
        config,
        workspaceId: providedId,
      }: {
        id: string;
        config: Record<string, unknown>;
        workspaceId?: string;
      }) => executeUpsert("job", id, config, providedId ?? workspaceId),
    }),

    upsert_memory_own: tool({
      description:
        "Upsert a memory store (own entry) into the current workspace. " +
        "Pass `id` as the store name (e.g. 'notes', 'findings'). " +
        "The `config` shape: `{ type: 'short_term' | 'long_term' | 'scratchpad', strategy?: 'narrative' | 'retrieval' | 'dedup' | 'kv' }`. " +
        "Every workspace has default own stores: `notes` (short_term/narrative) and `memory` (long_term/narrative). " +
        "Upserting an existing name replaces it; a new name appends to `memory.own`. " +
        "If a draft exists, the entry is staged there; otherwise it writes directly to workspace.yml. " +
        "Returns `{ ok, diff, structural_issues }`. " +
        "Optional: pass workspaceId to target a different workspace.",
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      execute: ({
        id,
        config,
        workspaceId: providedId,
      }: {
        id: string;
        config: Record<string, unknown>;
        workspaceId?: string;
      }) => executeUpsert("memory-own", id, config, providedId ?? workspaceId),
    }),

    upsert_memory_mount: tool({
      description:
        "Upsert a memory mount into the current workspace. " +
        "Pass `id` as the mount name (e.g. 'user-notes', 'shared-kb'). " +
        "The `config` shape: `{ source: '{wsId|_global}/{kind}/{memoryName}', mode: 'ro' | 'rw', scope: 'workspace' | 'job' | 'agent', scopeTarget?: string, filter?: {...} }`. " +
        "Every workspace has default mounts: `user-notes` and `user-memory` (read-only from the user workspace, workspace scope). " +
        "Upserting an existing name replaces it; a new name appends to `memory.mounts`. " +
        "If a draft exists, the entry is staged there; otherwise it writes directly to workspace.yml. " +
        "Returns `{ ok, diff, structural_issues }`. " +
        "Optional: pass workspaceId to target a different workspace.",
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      execute: ({
        id,
        config,
        workspaceId: providedId,
      }: {
        id: string;
        config: Record<string, unknown>;
        workspaceId?: string;
      }) => executeUpsert("memory-mount", id, config, providedId ?? workspaceId),
    }),
  };
}
