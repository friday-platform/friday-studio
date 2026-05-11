import type { AtlasTools } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import { tool } from "ai";
import { z } from "zod";

const RegisterAgentInput = z.object({
  entrypoint: z
    .string()
    .min(1)
    .describe(
      "Absolute path to the agent's entry file (e.g. /Users/me/projects/triage-agent/agent.py). " +
        "The daemon spawns the file with FRIDAY_VALIDATE_ID, listens for the metadata it " +
        "publishes over NATS, and copies the source dir into ~/.friday/agents/{id}@{version}/.",
    ),
});

const DeleteAgentInput = z.object({
  id: z
    .string()
    .min(1)
    .describe("Agent id from metadata.json — typically lower-kebab-case, e.g. 'triage-agent'."),
  version: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional semver string (e.g. '0.2.0') to scope the delete to a single version. " +
        "Omit to delete every version of the agent. Bundled and SDK agents cannot be removed " +
        "this way — they live in code, not on disk.",
    ),
});

const RegisterAgentResponseSchema = z.object({
  ok: z.literal(true),
  agent: z.object({
    id: z.string(),
    version: z.string(),
    description: z.string(),
    path: z.string(),
  }),
});

const RegisterAgentErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  phase: z.enum(["prereqs", "validate", "write"]).optional(),
});

const DeleteAgentResponseSchema = z.object({
  ok: z.literal(true),
  agent: z.object({ id: z.string(), deleted: z.array(z.string()) }),
});

const DeleteAgentErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  deleted: z.array(z.string()).optional(),
});

async function readResponseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Build the `register_agent` tool for workspace chat.
 *
 * Replaces the prior `run_code` + curl workaround documented at
 * `prompt.txt:145`. POSTs to the existing `/api/agents/register` endpoint,
 * which spawns the agent under FRIDAY_VALIDATE_ID, captures the metadata it
 * publishes over NATS, and installs the source into
 * `~/.friday/agents/{id}@{version}/`. Idempotent: a second call with the
 * same entrypoint overwrites the install dir, which is also the update path
 * — no separate `update_agent_source` tool, the chat uses this verb for both
 * create and update.
 */
export function createRegisterAgentTool(logger: Logger): AtlasTools {
  return {
    register_agent: tool({
      description:
        "Register or update a user agent (.py file) in the global agent registry. " +
        "Pass the absolute path to agent.py (or equivalent entrypoint); the daemon spawns it, " +
        "captures the metadata it publishes via the friday-agent-sdk validate handshake, " +
        "and installs the source under ~/.friday/agents/{id}@{version}/. Idempotent — " +
        "re-registering with the same entrypoint overwrites the install dir, so this is " +
        "also the update path for editing an existing user agent. After registering, call " +
        "`upsert_agent` to wire the agent into a workspace's agents list.",
      inputSchema: RegisterAgentInput,
      execute: async ({ entrypoint }) => {
        const url = `${getAtlasDaemonUrl()}/api/agents/register`;
        let res: Response;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ entrypoint }),
          });
        } catch (err) {
          logger.error("register_agent fetch failed", { entrypoint, error: stringifyError(err) });
          return { ok: false as const, error: `register_agent failed: network error` };
        }

        const body = await readResponseBody(res);

        if (!res.ok) {
          const parsed = RegisterAgentErrorSchema.safeParse(body);
          const error = parsed.success
            ? parsed.data.error
            : `register_agent failed with status ${res.status}`;
          const phase = parsed.success ? parsed.data.phase : undefined;
          logger.warn("register_agent failed", { entrypoint, status: res.status, error, phase });
          return phase ? { ok: false as const, error, phase } : { ok: false as const, error };
        }

        const parsed = RegisterAgentResponseSchema.safeParse(body);
        if (!parsed.success) {
          logger.warn("register_agent: unexpected response shape", {
            entrypoint,
            issues: parsed.error.issues,
          });
          return {
            ok: false as const,
            error: "register_agent returned an unexpected response shape",
          };
        }

        logger.info("register_agent succeeded", {
          entrypoint,
          id: parsed.data.agent.id,
          version: parsed.data.agent.version,
        });
        return { ok: true as const, agent: parsed.data.agent };
      },
    }),
  };
}

/**
 * Build the `delete_agent_from_registry` tool for workspace chat.
 *
 * Removes the on-disk install dir for a user agent under
 * `~/.friday/agents/{id}@{version}/`. With `version` omitted, every version
 * of the agent is removed. The daemon reloads the registry after a
 * successful delete; downstream `upsert_agent` calls referencing the
 * removed id will then fail validation, which is the user-visible signal
 * that the agent is gone.
 */
export function createDeleteAgentFromRegistryTool(logger: Logger): AtlasTools {
  return {
    delete_agent_from_registry: tool({
      description:
        "Remove a user agent from the global registry. Deletes the on-disk install dir " +
        "under ~/.friday/agents/{id}@{version}/ and reloads the registry. Pass `version` " +
        "to scope the delete; omit it to remove every version. Bundled and SDK agents " +
        "cannot be deleted via this tool — they live in code. After deleting, any " +
        "workspace that referenced the agent via `upsert_agent` will fail validation " +
        "until the reference is removed or replaced.",
      inputSchema: DeleteAgentInput,
      execute: async ({ id, version }) => {
        const base = `${getAtlasDaemonUrl()}/api/agents/${encodeURIComponent(id)}`;
        const url = version ? `${base}?version=${encodeURIComponent(version)}` : base;

        let res: Response;
        try {
          res = await fetch(url, { method: "DELETE" });
        } catch (err) {
          logger.error("delete_agent_from_registry fetch failed", {
            id,
            version,
            error: stringifyError(err),
          });
          return { ok: false as const, error: `delete_agent_from_registry failed: network error` };
        }

        const body = await readResponseBody(res);

        if (!res.ok) {
          const parsed = DeleteAgentErrorSchema.safeParse(body);
          const error = parsed.success
            ? parsed.data.error
            : `delete_agent_from_registry failed with status ${res.status}`;
          logger.warn("delete_agent_from_registry failed", {
            id,
            version,
            status: res.status,
            error,
          });
          return parsed.success && parsed.data.deleted
            ? { ok: false as const, error, deleted: parsed.data.deleted }
            : { ok: false as const, error };
        }

        const parsed = DeleteAgentResponseSchema.safeParse(body);
        if (!parsed.success) {
          logger.warn("delete_agent_from_registry: unexpected response shape", {
            id,
            issues: parsed.error.issues,
          });
          return {
            ok: false as const,
            error: "delete_agent_from_registry returned an unexpected response shape",
          };
        }

        logger.info("delete_agent_from_registry succeeded", {
          id,
          version,
          deletedCount: parsed.data.agent.deleted.length,
        });
        return { ok: true as const, agent: parsed.data.agent };
      },
    }),
  };
}
