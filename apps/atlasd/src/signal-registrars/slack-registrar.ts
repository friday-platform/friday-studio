import process from "node:process";
import type { MergedConfig } from "@atlas/config";
import { createLogger } from "@atlas/logger";
import type { WorkspaceSignalRegistrar } from "@atlas/workspace/types";
import { z } from "zod";

const logger = createLogger({ component: "slack-signal-registrar" });

const EnableEventsResultSchema = z.object({ enabled: z.boolean(), reason: z.string().optional() });
const ByWorkspaceResponseSchema = z.object({ credential_id: z.string(), app_id: z.string() });

export interface SlackEventManager {
  enableEvents(credentialId: string): Promise<{ enabled: boolean; reason?: string }>;
  disableEvents(credentialId: string): Promise<void>;
}

export interface SlackRegistrarDeps {
  eventManager: SlackEventManager;
}

type WorkspaceBinding = { credentialId: string; appId: string };

export class SlackSignalRegistrar implements WorkspaceSignalRegistrar {
  private readonly deps: SlackRegistrarDeps;
  private readonly enabledApps = new Set<string>();
  private readonly workspaceBindings = new Map<string, WorkspaceBinding>();

  constructor(deps: SlackRegistrarDeps) {
    this.deps = deps;
  }

  async registerWorkspace(
    workspaceId: string,
    _workspacePath: string,
    config: MergedConfig,
  ): Promise<void> {
    const appId = findSlackAppId(config);
    if (!appId) return;

    if (this.enabledApps.has(appId)) {
      logger.debug("slack_events_already_enabled", { workspaceId, appId });
      return;
    }

    try {
      const credentialId = await this.resolveCredentialId(workspaceId);
      if (!credentialId) return;

      const result = await this.deps.eventManager.enableEvents(credentialId);
      if (!result.enabled) {
        logger.debug("slack_credential_incomplete", {
          workspaceId,
          credentialId,
          reason: result.reason,
        });
        return;
      }

      this.enabledApps.add(appId);
      this.workspaceBindings.set(workspaceId, { credentialId, appId });
      logger.info("slack_events_enabled", { workspaceId, appId, credentialId });
    } catch (error) {
      logger.error("slack_register_failed", { error, workspaceId, appId });
    }
  }

  async unregisterWorkspace(workspaceId: string): Promise<void> {
    const binding = this.workspaceBindings.get(workspaceId);
    if (!binding) return;

    try {
      await this.deps.eventManager.disableEvents(binding.credentialId);
      logger.info("slack_events_disabled", { workspaceId, credentialId: binding.credentialId });
    } catch (error) {
      logger.error("slack_unregister_failed", {
        error,
        workspaceId,
        credentialId: binding.credentialId,
      });
    }

    this.enabledApps.delete(binding.appId);
    this.workspaceBindings.delete(workspaceId);
  }

  shutdown(): Promise<void> {
    this.enabledApps.clear();
    this.workspaceBindings.clear();
    return Promise.resolve();
  }

  private async resolveCredentialId(workspaceId: string): Promise<string | null> {
    const linkServiceUrl = process.env.LINK_SERVICE_URL ?? "http://localhost:3100";
    const url = `${linkServiceUrl}/internal/v1/slack-apps/by-workspace/${encodeURIComponent(workspaceId)}`;

    const headers: Record<string, string> = {};
    if (process.env.LINK_DEV_MODE !== "true") {
      const atlasKey = process.env.ATLAS_KEY;
      if (atlasKey) {
        headers.Authorization = `Bearer ${atlasKey}`;
      }
    }

    const res = await fetch(url, { headers });

    if (res.status === 404) {
      logger.debug("slack_no_credential_for_workspace", { workspaceId });
      return null;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Failed to resolve slack-app for workspace '${workspaceId}': ${res.status} ${body}`,
      );
    }

    const { credential_id } = ByWorkspaceResponseSchema.parse(await res.json());
    return credential_id;
  }
}

function findSlackAppId(config: MergedConfig): string | null {
  const signals = config.workspace?.signals;
  if (!signals) return null;

  for (const signal of Object.values(signals)) {
    if (signal?.provider === "slack") {
      return signal.config.app_id ?? null;
    }
  }
  return null;
}

export function createLinkSlackEventManager(): SlackEventManager {
  const linkServiceUrl = process.env.LINK_SERVICE_URL ?? "http://localhost:3100";

  async function callEvents(credentialId: string, enable: boolean): Promise<unknown> {
    const url = `${linkServiceUrl}/internal/v1/slack-apps/${encodeURIComponent(credentialId)}/events`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    const atlasKey = process.env.ATLAS_KEY;
    if (atlasKey) {
      headers.Authorization = `Bearer ${atlasKey}`;
    }

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ enable }) });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Link events endpoint returned ${res.status}: ${body}`);
    }

    return res.json();
  }

  return {
    async enableEvents(credentialId) {
      const body = await callEvents(credentialId, true);
      return EnableEventsResultSchema.parse(body);
    },
    async disableEvents(credentialId) {
      await callEvents(credentialId, false);
    },
  };
}
