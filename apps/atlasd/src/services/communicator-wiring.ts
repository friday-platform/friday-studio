/**
 * Generic atlasd → Link communicator wiring client.
 *
 * Single connect-communicator path for all chat providers (Slack, Telegram,
 * Discord, Teams, WhatsApp). The wiring table stores `(workspace_id, provider,
 * credential_id, connection_id)`; daemon resolves credentials per-workspace at
 * runtime via the wiring lookup, so workspace.yml only carries `{ kind }` —
 * no inline secrets.
 *
 * `connection_id` is the routing key used by inbound webhook handlers to find
 * the right workspace from an incoming event. For Telegram it's the post-colon
 * segment of `bot_token` — the segment Telegram echoes back in webhook URLs
 * registered via `setWebhook(url=…/platform/telegram/<SUFFIX>)`. Treated as
 * semi-sensitive (the full token = bot takeover): stored under RLS, never
 * logged unredacted. Per-kind extraction lives in `deriveConnectionId`.
 */

import process from "node:process";
import {
  type CommunicatorKind,
  CommunicatorConfigSchema,
  CommunicatorKindSchema,
  type WorkspaceConfig,
} from "@atlas/config";
import type { MutationResult } from "@atlas/config/mutations";
import { fetchLinkCredential } from "@atlas/core/mcp-registry/credential-resolver";
import { createLogger } from "@atlas/logger";
import { z } from "zod";

const logger = createLogger({ component: "communicator-wiring" });

export { CommunicatorKindSchema };
export type { CommunicatorKind };

/** Telegram credential secret as stored in Link after autoFields injection. */
export const TelegramCredentialSecretSchema = z.object({
  bot_token: z.string().min(1),
  webhook_secret: z.string().min(1),
});

/**
 * Per-kind credential secret schemas used for `deriveConnectionId` routing-key
 * extraction. Each schema only asserts the field used as the connection_id; the
 * full provider-side schema lives in `apps/link/src/providers/*.ts`.
 */
const DiscordCredentialSecretSchema = z.object({ application_id: z.string().min(1) });

const TeamsCredentialSecretSchema = z.object({ app_id: z.string().min(1) });

const WhatsappCredentialSecretSchema = z.object({ phone_number_id: z.string().min(1) });

const SlackCredentialSecretSchema = z.object({ app_id: z.string().min(1) });

function getLinkServiceUrl(): string {
  return process.env.LINK_SERVICE_URL ?? "http://localhost:3100";
}

/**
 * Local URL for webhook-tunnel's `/status` endpoint. Defaults to
 * `http://localhost:9090` (the standard webhook-tunnel listener); override via
 * `WEBHOOK_TUNNEL_URL` for non-default ports / dev rigs.
 */
function getWebhookTunnelUrl(): string {
  return process.env.WEBHOOK_TUNNEL_URL ?? "http://localhost:9090";
}

const TunnelStatusSchema = z.object({ url: z.string().url().nullable().optional() });

/**
 * Fetches the public tunnel URL from webhook-tunnel's `/status` endpoint.
 *
 * Returns the cloudflare-tunnel URL exposed to the public internet — NOT
 * `localhost:9090`. Telegram (and other platforms) need a publicly reachable
 * URL to deliver webhooks to. Throws a clear actionable error if the tunnel is
 * down or hasn't yet provisioned a public URL.
 */
export async function resolveTunnelUrl(): Promise<string> {
  const statusUrl = `${getWebhookTunnelUrl()}/status`;
  let res: Response;
  try {
    res = await fetch(statusUrl);
  } catch (error) {
    throw new Error(
      `Public tunnel not available. Start it with 'deno task webhook-tunnel'. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Public tunnel not available (status ${res.status}). Start it with 'deno task webhook-tunnel'.`,
    );
  }
  const parsed = TunnelStatusSchema.parse(await res.json());
  if (!parsed.url) {
    throw new Error(
      "Public tunnel reachable but no public URL provisioned yet. Wait a moment and retry, or restart 'deno task webhook-tunnel'.",
    );
  }
  return parsed.url;
}

function getLinkAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.LINK_DEV_MODE !== "true") {
    const atlasKey = process.env.FRIDAY_KEY;
    if (atlasKey) {
      headers.Authorization = `Bearer ${atlasKey}`;
    }
  }
  return headers;
}

/**
 * Derive the routing-key (`connection_id`) for a credential, per kind.
 *
 * Each kind picks the field that the platform echoes back to inbound webhooks
 * (and that the daemon uses to route inbound events to a workspace):
 *   - slack:    `app_id` (matches `api_app_id` in the Slack event payload —
 *               daemon serves a single `/platform/slack` route and routes by
 *               body, not path; see `apps/atlasd/routes/signals/platform.ts`)
 *   - telegram: post-colon segment of `bot_token`
 *   - discord:  `application_id` (Discord interactions arrive keyed on app)
 *   - teams:    `app_id` (matches `recipient.id` Teams sends inbound)
 *   - whatsapp: `phone_number_id` (Meta echoes via `metadata.phone_number_id`)
 */
export async function deriveConnectionId(
  kind: CommunicatorKind,
  credentialId: string,
): Promise<string> {
  if (kind === "slack") {
    const credential = await fetchLinkCredential(credentialId, logger);
    const secret = SlackCredentialSecretSchema.parse(credential.secret);
    return secret.app_id;
  }
  if (kind === "telegram") {
    const credential = await fetchLinkCredential(credentialId, logger);
    const secret = TelegramCredentialSecretSchema.parse(credential.secret);
    const suffix = secret.bot_token.split(":")[1];
    if (!suffix) {
      throw new Error(`Invalid telegram bot_token format for credential ${credentialId}`);
    }
    return suffix;
  }
  if (kind === "discord") {
    const credential = await fetchLinkCredential(credentialId, logger);
    const secret = DiscordCredentialSecretSchema.parse(credential.secret);
    return secret.application_id;
  }
  if (kind === "teams") {
    const credential = await fetchLinkCredential(credentialId, logger);
    const secret = TeamsCredentialSecretSchema.parse(credential.secret);
    return secret.app_id;
  }
  if (kind === "whatsapp") {
    const credential = await fetchLinkCredential(credentialId, logger);
    const secret = WhatsappCredentialSecretSchema.parse(credential.secret);
    return secret.phone_number_id;
  }
  return credentialId;
}

const WireOkResponseSchema = z.object({ ok: z.literal(true) });
const DisconnectResponseSchema = z.object({ credential_id: z.string().nullable() });

/**
 * POST `/internal/v1/communicator/wire` to Link with the wiring tuple.
 * Caller is responsible for deriving `connectionId` per kind via
 * `deriveConnectionId`, and for resolving `callbackBaseUrl` via
 * `resolveTunnelUrl`. Link's `/wire` may invoke a provider's `registerWebhook`
 * hook (e.g. Telegram `setWebhook`); failures roll back the wiring atomically
 * and surface as a non-2xx here.
 */
export async function wireCommunicator(
  workspaceId: string,
  provider: CommunicatorKind,
  credentialId: string,
  connectionId: string,
  callbackBaseUrl: string,
): Promise<void> {
  const url = `${getLinkServiceUrl()}/internal/v1/communicator/wire`;
  const res = await fetch(url, {
    method: "POST",
    headers: getLinkAuthHeaders(),
    body: JSON.stringify({
      workspace_id: workspaceId,
      provider,
      credential_id: credentialId,
      connection_id: connectionId,
      callback_base_url: callbackBaseUrl,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Link wire endpoint returned ${res.status}: ${body}`);
  }

  WireOkResponseSchema.parse(await res.json());
}

/**
 * POST `/internal/v1/communicator/disconnect` to Link. Returns the deleted
 * wiring's credential_id (or null if no wiring existed — idempotent).
 *
 * `callbackBaseUrl` is forwarded so providers' `unregisterWebhook` hooks have
 * symmetric input shape with `registerWebhook`. Telegram ignores it; other
 * platforms may need it (e.g. to identify which subscription to remove).
 */
export async function disconnectCommunicator(
  workspaceId: string,
  provider: CommunicatorKind,
  callbackBaseUrl: string,
): Promise<{ credentialId: string | null }> {
  const url = `${getLinkServiceUrl()}/internal/v1/communicator/disconnect`;
  const res = await fetch(url, {
    method: "POST",
    headers: getLinkAuthHeaders(),
    body: JSON.stringify({
      workspace_id: workspaceId,
      provider,
      callback_base_url: callbackBaseUrl,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Link disconnect endpoint returned ${res.status}: ${body}`);
  }

  const parsed = DisconnectResponseSchema.parse(await res.json());
  return { credentialId: parsed.credential_id };
}

const WiringResponseSchema = z.object({
  wiring: z.object({ credential_id: z.string(), connection_id: z.string().nullable() }).nullable(),
});

const ResolveResponseSchema = z.object({
  workspace_id: z.string(),
  credential_id: z.string(),
  secret: z.unknown(),
});

/**
 * GET `/internal/v1/communicator/resolve?connection_id=&provider=`. Atomic
 * lookup for inbound webhook routing — returns the workspace + credential
 * + secret for a `(connection_id, provider)` pair. Returns null on 404 (no
 * wiring) or transient Link errors (the caller's downstream legacy fallbacks
 * still work).
 */
export async function resolveCommunicatorByConnection(
  connectionId: string,
  provider: CommunicatorKind,
): Promise<{ workspaceId: string; credentialId: string; secret: unknown } | null> {
  const url = new URL(`${getLinkServiceUrl()}/internal/v1/communicator/resolve`);
  url.searchParams.set("connection_id", connectionId);
  url.searchParams.set("provider", provider);

  let res: Response;
  try {
    res = await fetch(url.toString(), { headers: getLinkAuthHeaders() });
  } catch (error) {
    logger.debug("communicator_resolve_link_unreachable", {
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (res.status === 404) return null;

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Link resolve endpoint returned ${res.status}: ${body}`);
  }

  const parsed = ResolveResponseSchema.parse(await res.json());
  return {
    workspaceId: parsed.workspace_id,
    credentialId: parsed.credential_id,
    secret: parsed.secret,
  };
}

/**
 * GET `/internal/v1/communicator/wiring?workspace_id=&provider=`. Returns the
 * wired credential_id for the given workspace+provider, or null if unwired.
 * Returns null on Link unreachability (matches the Slack-fallback policy of
 * treating "Link down" as "no wiring").
 */
export async function findCommunicatorWiring(
  workspaceId: string,
  provider: CommunicatorKind,
): Promise<{ credentialId: string; connectionId: string | null } | null> {
  const url = new URL(`${getLinkServiceUrl()}/internal/v1/communicator/wiring`);
  url.searchParams.set("workspace_id", workspaceId);
  url.searchParams.set("provider", provider);

  let res: Response;
  try {
    res = await fetch(url.toString(), { headers: getLinkAuthHeaders() });
  } catch (error) {
    logger.debug("communicator_wiring_link_unreachable", {
      workspaceId,
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Link wiring lookup returned ${res.status}: ${body}`);
  }

  const parsed = WiringResponseSchema.parse(await res.json());
  if (!parsed.wiring) return null;
  return { credentialId: parsed.wiring.credential_id, connectionId: parsed.wiring.connection_id };
}

/**
 * Returns a `WorkspaceConfig` mutation that idempotently sets
 * `communicators[kind] = { kind }`. No-op if the block already exists with
 * the same kind. Strips any prior bot_token / webhook_secret fields from the
 * existing block, since the new shape is kind-only — Link owns the secrets.
 */
export function setCommunicatorMutation(
  kind: CommunicatorKind,
): (config: WorkspaceConfig) => MutationResult<WorkspaceConfig> {
  return (config) => {
    const existing = config.communicators?.[kind];
    if (existing && existing.kind === kind && Object.keys(existing).length === 1) {
      return { ok: true, value: config };
    }

    const next = { kind } as const;
    const validated = CommunicatorConfigSchema.safeParse(next);
    if (!validated.success) {
      return {
        ok: false,
        error: {
          type: "validation",
          message: `Invalid communicator block for kind=${kind}`,
          issues: validated.error.issues,
        },
      };
    }

    return {
      ok: true,
      value: {
        ...config,
        communicators: { ...(config.communicators ?? {}), [kind]: validated.data },
      },
    };
  };
}

/**
 * Returns a `WorkspaceConfig` mutation that removes
 * `communicators[kind]`. No-op if absent. Drops the whole `communicators`
 * map when removing the last entry, mirroring how callers expect a clean
 * yml to omit the key entirely.
 */
export function removeCommunicatorMutation(
  kind: CommunicatorKind,
): (config: WorkspaceConfig) => MutationResult<WorkspaceConfig> {
  return (config) => {
    if (!config.communicators?.[kind]) {
      return { ok: true, value: config };
    }
    const { [kind]: _removed, ...rest } = config.communicators;
    if (Object.keys(rest).length === 0) {
      const { communicators: _drop, ...withoutCommunicators } = config;
      return { ok: true, value: withoutCommunicators };
    }
    return { ok: true, value: { ...config, communicators: rest } };
  };
}
