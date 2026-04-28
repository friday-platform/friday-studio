import process from "node:process";
import type { WorkspaceConfig } from "@atlas/config";
import { createSignal, type MutationResult } from "@atlas/config/mutations";
import { createLogger } from "@atlas/logger";
import { z } from "zod";

const logger = createLogger({ component: "slack-auto-wire" });

export interface SlackAutoWireDeps {
  findUnwired: () => Promise<{ credentialId: string; appId: string } | null>;
  wireToWorkspace: (
    credentialId: string,
    workspaceId: string,
    workspaceName: string,
    workspaceDescription?: string,
  ) => Promise<string>;
}

export type AutoWireResult = { credentialId: string; appId: string };

/**
 * Find the user's most recent unwired Slack app credential and wire it to a workspace.
 * Returns the credential/app info if wiring succeeded, null if no unwired credential exists.
 */
export async function tryAutoWireSlackApp(
  deps: SlackAutoWireDeps,
  workspaceId: string,
  workspaceName: string,
  workspaceDescription?: string,
): Promise<AutoWireResult | null> {
  const unwired = await deps.findUnwired();
  if (!unwired) {
    logger.debug("slack_auto_wire_no_unwired_credential");
    return null;
  }

  const appId = await deps.wireToWorkspace(
    unwired.credentialId,
    workspaceId,
    workspaceName,
    workspaceDescription,
  );

  logger.info("slack_auto_wire_success", {
    credentialId: unwired.credentialId,
    appId,
    workspaceId,
  });

  return { credentialId: unwired.credentialId, appId };
}

/** Returns a config mutation that adds a Slack signal if none exists. Idempotent. */
export function slackSignalMutation(
  appId: string,
): (config: WorkspaceConfig) => MutationResult<WorkspaceConfig> {
  return (config) => {
    const signals = config.signals ?? {};

    const existingEntry = Object.entries(signals).find(([, s]) => s.provider === "slack");
    if (existingEntry) {
      const [key, signal] = existingEntry;
      if (signal.provider === "slack" && signal.config.app_id !== appId) {
        logger.warn("slack_signal_app_id_mismatch", {
          existingAppId: signal.config.app_id,
          newAppId: appId,
          signalKey: key,
        });
        return {
          ok: true as const,
          value: {
            ...config,
            signals: {
              ...signals,
              [key]: { ...signal, config: { ...signal.config, app_id: appId } },
            },
          },
        };
      }
      return { ok: true, value: config };
    }

    return createSignal(config, "slack", {
      description: "Slack messages",
      provider: "slack",
      config: { app_id: appId },
    });
  };
}

const WireResponseSchema = z.object({ ok: z.literal(true), app_id: z.string() });

export function createLinkWireClient(): SlackAutoWireDeps["wireToWorkspace"] {
  const linkServiceUrl = process.env.LINK_SERVICE_URL ?? "http://localhost:3100";

  return async (credentialId, workspaceId, workspaceName, workspaceDescription) => {
    const url = `${linkServiceUrl}/internal/v1/slack-apps/${encodeURIComponent(credentialId)}/wire`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    const atlasKey = process.env.FRIDAY_KEY;
    if (atlasKey) {
      headers.Authorization = `Bearer ${atlasKey}`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspace_id: workspaceId,
        workspace_name: workspaceName,
        workspace_description: workspaceDescription,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Link wire endpoint returned ${res.status}: ${body}`);
    }

    const body = WireResponseSchema.parse(await res.json());
    return body.app_id;
  };
}

/** Best-effort toggle — logs warnings on failure rather than throwing. */
async function setSlackEventSubscriptions(credentialId: string, enable: boolean): Promise<void> {
  const linkServiceUrl = process.env.LINK_SERVICE_URL ?? "http://localhost:3100";
  const url = `${linkServiceUrl}/internal/v1/slack-apps/${encodeURIComponent(credentialId)}/events`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  const atlasKey = process.env.FRIDAY_KEY;
  if (atlasKey) {
    headers.Authorization = `Bearer ${atlasKey}`;
  }

  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ enable }) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn("slack_event_subscriptions_failed", {
        credentialId,
        enable,
        status: res.status,
        body,
      });
    } else {
      logger.info(
        enable ? "slack_event_subscriptions_enabled" : "slack_event_subscriptions_disabled",
        { credentialId },
      );
    }
  } catch (error) {
    logger.warn("slack_event_subscriptions_error", { credentialId, enable, error });
  }
}

export function enableSlackEventSubscriptions(credentialId: string): Promise<void> {
  return setSlackEventSubscriptions(credentialId, true);
}

export function disableSlackEventSubscriptions(credentialId: string): Promise<void> {
  return setSlackEventSubscriptions(credentialId, false);
}

const UnwiredResponseSchema = z.object({ credential_id: z.string(), app_id: z.string() });

/** HTTP client for GET /internal/v1/slack-apps/unwired. */
export function createLinkUnwiredClient(): SlackAutoWireDeps["findUnwired"] {
  const linkServiceUrl = process.env.LINK_SERVICE_URL ?? "http://localhost:3100";

  return async () => {
    const url = `${linkServiceUrl}/internal/v1/slack-apps/unwired`;
    const headers: Record<string, string> = {};

    const atlasKey = process.env.FRIDAY_KEY;
    if (atlasKey) {
      headers.Authorization = `Bearer ${atlasKey}`;
    }

    const res = await fetch(url, { headers });

    if (res.status === 404) return null;

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Link unwired endpoint returned ${res.status}: ${body}`);
    }

    const body = UnwiredResponseSchema.parse(await res.json());
    return { credentialId: body.credential_id, appId: body.app_id };
  };
}
