import type { AtlasTools } from "@atlas/agent-sdk";
import { ElicitationStorage } from "@atlas/core/elicitations";
import { isSecretKey, MASKED_VALUE } from "@atlas/core/mcp-registry/env-secret-mask";
import type { Logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { tool } from "ai";
import { z } from "zod";

/**
 * Chat-side `env_set` / `env_get` factory. Mirrors the platform MCP tools at
 * `packages/mcp-server/src/tools/env/` so the chat supervisor can read and
 * propose changes to the workspace `.env`.
 *
 * Why a chat factory rather than the MCP tools: chat composes its toolset
 * from chat-side factories and does not connect to the platform MCP server,
 * so the MCP-registered `env_*` tools never reach a chat LLM. Without these,
 * a chat asked to "save X in env" has no tool to reach for and falls back to
 * hand-editing `.env` files through `run_code` — which has corrupted the
 * daemon `.env` in practice.
 *
 * `env_set` does NOT write directly: a chat turn cannot block on the user, so
 * it raises an `env-write` elicitation (the confirmation card) and returns
 * `pending_confirmation`; the daemon commits the write when the user answers
 * (see the `env-write` branch in `apps/atlasd/routes/elicitations`). To verify
 * a write landed, call `env_get` on a later turn.
 */

/** Chat elicitations have no parent job timeout to derive from — fixed TTL. */
const ELICITATION_TTL_MS = 30 * 60 * 1000;

export interface CreateEnvToolsOpts {
  /** Current workspace — the only workspace a `workspace`-scoped write can target. */
  workspaceId: string;
  /** Chat session id — used as the elicitation's `sessionId`. */
  sessionId: string;
  /** Daemon self-loopback URL — `env_get` reads through the per-key env routes. */
  daemonUrl: string;
  logger: Logger;
}

export function createEnvTools(opts: CreateEnvToolsOpts): AtlasTools {
  const { workspaceId, sessionId, daemonUrl, logger } = opts;

  return {
    env_set: tool({
      description:
        "Propose setting one or more environment variables. Does NOT write immediately — it " +
        "raises a confirmation card in chat; the user reviews the keys and values and confirms " +
        "or denies, and the daemon applies the write on confirm. `workspace` scope (default) " +
        "writes the current workspace's `.env`; `global` writes the daemon's `.env`. " +
        "For secret-bearing keys (anything matching token/key/secret/password/credential) pass " +
        'an empty string `""` as the value — the confirmation card lets the user type the real ' +
        "secret directly, so the value never enters chat history. Exception: if the user already " +
        "typed the literal value in chat, pass it through so they don't have to retype it (the " +
        "value is already in the transcript, so passing it gains no further privacy). For " +
        "non-secret values (e.g. a workspace slug, a log path, an API base URL) pass the literal " +
        "value. Returns immediately as `pending_confirmation`; call `env_get` on a later turn to " +
        "verify.",
      inputSchema: z.object({
        scope: z
          .enum(["workspace", "global"])
          .default("workspace")
          .describe("'workspace' (default, the current workspace's .env) or 'global'"),
        vars: z
          .record(
            z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "env var keys must be POSIX identifiers"),
            z.string().regex(/^[^\r\n]*$/, "env var values must not contain newlines"),
          )
          .refine((v) => Object.keys(v).length > 0, "provide at least one env var to set")
          .describe(
            'Environment variables as a { KEY: value } map. Pass `""` for secret-bearing ' +
              "keys so the user can fill in the real value via the confirmation card — unless " +
              "they already typed the literal value in chat, in which case pass it through.",
          ),
      }),
      execute: async ({ scope, vars }) => {
        const keys = Object.keys(vars);
        logger.info("env_set (chat) called", { scope, workspaceId, keys });

        // Reads of secret-looking keys come back masked as `********`. An agent
        // doing read-modify-write would otherwise propose writing the mask
        // sentinel as the real value — refuse it rather than corrupt the `.env`.
        const maskedKeys = keys.filter((k) => vars[k] === MASKED_VALUE);
        if (maskedKeys.length > 0) {
          return {
            error:
              `Refusing to write the masked sentinel (${MASKED_VALUE}) as a value for ` +
              `${maskedKeys.join(", ")}. env_get masks secret-looking keys — supply the real ` +
              "value, or leave the key unchanged.",
          };
        }

        const secretLookingKeys = keys.filter(isSecretKey);
        const where = scope === "global" ? "the global" : "this workspace's";
        const question =
          keys.length === 1
            ? `Set \`${keys[0]}\` in ${where} env?`
            : `Set ${keys.length} env vars (${keys.join(", ")}) in ${where} env?`;

        try {
          const created = await ElicitationStorage.create({
            // The elicitation lives in the session's workspace; a `workspace`-
            // scoped write targets that same workspace via the envelope's
            // `workspaceId` at commit time, never an args-supplied one.
            workspaceId,
            sessionId,
            kind: "env-write",
            question,
            options: [
              { label: "Confirm", value: "confirm" },
              { label: "Deny", value: "deny" },
            ],
            pendingTool: { name: "env_set", args: { scope, vars } },
            expiresAt: new Date(Date.now() + ELICITATION_TTL_MS).toISOString(),
          });
          if (!created.ok) {
            logger.error("env_set (chat) elicitation create failed", {
              scope,
              error: created.error,
            });
            return { error: `Failed to create env-set confirmation: ${created.error}` };
          }

          // Non-blocking: the chat turn cannot wait. The daemon commits the
          // write when the user answers the card.
          return {
            status: "pending_confirmation",
            elicitationId: created.data.id,
            scope,
            keys,
            message:
              "Awaiting user confirmation in chat — nothing is written until the user confirms. " +
              "Call env_get on a later turn to verify.",
            ...(secretLookingKeys.length > 0
              ? {
                  secretLookingKeys,
                  note:
                    "Some keys look secret-bearing — the user will type the real value in the " +
                    "confirmation card so it stays out of chat. For real third-party credentials, " +
                    "consider a connected integration (Link) instead of `.env`.",
                }
              : {}),
          };
        } catch (err) {
          logger.error("env_set (chat) threw", { scope, workspaceId, error: err });
          return { error: `env set failed: ${stringifyError(err)}` };
        }
      },
    }),

    env_get: tool({
      description:
        "Read one environment variable. `workspace` scope (default) reads the current " +
        "workspace's `.env`; `global` reads the daemon's `.env`. If the key looks " +
        "secret-bearing (token/key/secret/password/credential) the value is masked — view a " +
        "real secret in the settings UI. Use this to verify an `env_set` landed on a later turn.",
      inputSchema: z.object({
        scope: z
          .enum(["workspace", "global"])
          .default("workspace")
          .describe("'workspace' (default) or 'global' (the daemon's .env)"),
        key: z.string().min(1).describe("Environment variable name"),
      }),
      execute: async ({ scope, key }) => {
        logger.info("env_get (chat) called", { scope, workspaceId, key });
        const base =
          scope === "global"
            ? `${daemonUrl}/api/config/env`
            : `${daemonUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/env`;
        try {
          const res = await fetch(`${base}/${encodeURIComponent(key)}`);
          if (res.status === 404) {
            return { scope, key, found: false };
          }
          if (!res.ok) {
            return { error: `env get failed: HTTP ${res.status} ${await res.text()}` };
          }
          const body = (await res.json()) as { value?: string };
          const secret = isSecretKey(key);
          return {
            scope,
            key,
            found: true,
            value: secret ? MASKED_VALUE : (body.value ?? ""),
            ...(secret
              ? {
                  masked: true,
                  note: "Key looks secret-bearing — value withheld. View it in the settings UI.",
                }
              : {}),
          };
        } catch (err) {
          logger.error("env_get (chat) fetch error", { scope, workspaceId, key, error: err });
          return { error: `env get failed: network error — ${stringifyError(err)}` };
        }
      },
    }),
  };
}
