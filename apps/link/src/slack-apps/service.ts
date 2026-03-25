/** Manages Slack app lifecycle: wiring, events, deletion, manifest updates. */

import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { z } from "zod";
import type { SlackAppWorkspaceRepository } from "../adapters/slack-app-workspace-repository.ts";
import type { WebhookSecretRepository } from "../adapters/webhook-secret-repository.ts";
import { AppInstallError } from "../app-install/errors.ts";
import type { Credential, StorageAdapter } from "../types.ts";
import {
  DESCRIPTION_MAX,
  PENDING_TOKEN,
  toDisplayName,
  withEventSubscriptions,
} from "./manifest.ts";
import { callSlackApi } from "./slack-api-client.ts";

const SlackApiSuccessSchema = z.object({ ok: z.literal(true) });
const SlackApiErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string().optional(),
  errors: z.array(z.record(z.string(), z.unknown())).optional(),
});
const SlackApiResponseSchema = z.discriminatedUnion("ok", [
  SlackApiSuccessSchema,
  SlackApiErrorSchema,
]);

const ManifestExportSuccessSchema = z.object({
  ok: z.literal(true),
  manifest: z.record(z.string(), z.unknown()),
});
const ManifestExportResponseSchema = z.discriminatedUnion("ok", [
  ManifestExportSuccessSchema,
  SlackApiErrorSchema,
]);

export const SlackAppSecretSchema = z.object({
  platform: z.literal("slack"),
  externalId: z.string(),
  access_token: z.string(),
  slack: z
    .object({ clientId: z.string(), clientSecret: z.string(), slackUserCredentialId: z.string() })
    .optional(),
});

const AccessTokenSecretSchema = z.object({ access_token: z.string() });

/** Partial manifest shape for fields used during wiring. Passthrough preserves unknown keys. */
const ManifestSubsetSchema = z
  .object({
    display_information: z.record(z.string(), z.unknown()).default({}),
    features: z
      .object({ bot_user: z.record(z.string(), z.unknown()).default({}) })
      .passthrough()
      .default({ bot_user: {} }),
  })
  .passthrough();

export type EventSubscriptionResult =
  | { status: "pending" }
  | { status: "enabled"; webhookUrl: string }
  | { status: "disabled" };

export class SlackAppService {
  constructor(
    private storage: StorageAdapter,
    private webhookSecrets: WebhookSecretRepository,
    private workspaceRepo: SlackAppWorkspaceRepository,
    private log = logger,
  ) {}

  /** Bind an unwired credential to a workspace and rename the Slack app. */
  async wireToWorkspace(
    credentialId: string,
    userId: string,
    workspaceId: string,
    workspaceName: string,
    workspaceDescription?: string,
  ): Promise<string> {
    const cred = await this.storage.get(credentialId, userId);
    if (!cred || cred.provider !== "slack-app") {
      throw new AppInstallError(
        "CREDENTIAL_NOT_FOUND",
        `Slack app credential not found: ${credentialId}`,
      );
    }

    const existing = await this.workspaceRepo.findByCredentialId(credentialId);
    if (existing) {
      throw new AppInstallError(
        "INVALID_CREDENTIAL",
        `Credential ${credentialId} is already wired to workspace ${existing.workspaceId}`,
      );
    }

    const secret = SlackAppSecretSchema.parse(cred.secret);
    const xoxpToken = await this.resolveUserToken(cred, userId);

    const rawManifest = await this.exportManifest(secret.externalId, xoxpToken);
    const currentManifest = ManifestSubsetSchema.parse(rawManifest);

    const updatedManifest = {
      ...rawManifest,
      display_information: {
        ...currentManifest.display_information,
        name: workspaceName,
        description: (workspaceDescription ?? "Friday AI agent").slice(0, DESCRIPTION_MAX),
      },
      features: {
        ...currentManifest.features,
        bot_user: {
          ...currentManifest.features.bot_user,
          display_name: toDisplayName(workspaceName),
        },
      },
    };

    const wireResult = await callSlackApi(
      "https://slack.com/api/apps.manifest.update",
      xoxpToken,
      { app_id: secret.externalId, manifest: updatedManifest },
      SlackApiResponseSchema,
      "Manifest update (wire)",
    );
    if (!wireResult.ok) {
      const details = wireResult.errors ? ` ${JSON.stringify(wireResult.errors)}` : "";
      throw new AppInstallError(
        "SLACK_API_ERROR",
        `Manifest update (wire) failed: ${wireResult.error ?? "unknown"}${details}`,
      );
    }

    await this.workspaceRepo.insert(credentialId, workspaceId);
    await this.storage.updateMetadata(credentialId, { displayName: workspaceName }, userId);

    this.log.info("slack_app_wired", {
      credentialId,
      appId: secret.externalId,
      workspaceId,
      workspaceName,
    });

    return secret.externalId;
  }

  /** Enable or disable event subscriptions for a Slack app. */
  async updateEventSubscriptions(
    credentialId: string,
    userId: string,
    enable: boolean,
    gatewayBase?: string,
  ): Promise<EventSubscriptionResult> {
    const cred = await this.storage.get(credentialId, userId);
    if (!cred || cred.provider !== "slack-app") {
      throw new AppInstallError(
        "CREDENTIAL_NOT_FOUND",
        `Slack app credential not found: ${credentialId}`,
      );
    }

    const secret = SlackAppSecretSchema.parse(cred.secret);
    if (secret.access_token === PENDING_TOKEN) {
      this.log.debug("slack_app_events_skip_pending", { credentialId });
      return { status: "pending" };
    }

    const xoxpToken = await this.resolveUserToken(cred, userId);

    const currentManifest = await this.exportManifest(secret.externalId, xoxpToken);

    let webhookUrl: string | undefined;
    if (enable) {
      if (!gatewayBase) {
        throw new AppInstallError("SLACK_API_ERROR", "GATEWAY_BASE not configured");
      }
      webhookUrl = `${gatewayBase}/v1/webhooks/slack/${userId}/${secret.externalId}`;
    }

    const updatedManifest = withEventSubscriptions(currentManifest, webhookUrl ?? null);

    const eventsResult = await callSlackApi(
      "https://slack.com/api/apps.manifest.update",
      xoxpToken,
      { app_id: secret.externalId, manifest: updatedManifest },
      SlackApiResponseSchema,
      "Manifest update",
    );
    if (!eventsResult.ok) {
      const details = eventsResult.errors ? ` ${JSON.stringify(eventsResult.errors)}` : "";
      throw new AppInstallError(
        "SLACK_API_ERROR",
        `Manifest update failed: ${eventsResult.error ?? "unknown"}${details}`,
      );
    }

    this.log.info("slack_app_events_updated", {
      credentialId,
      appId: secret.externalId,
      enable,
      webhookUrl,
    });

    if (webhookUrl) {
      return { status: "enabled", webhookUrl };
    }
    return { status: "disabled" };
  }

  /** Delete Slack app and credential. Slack API failure doesn't block local cleanup. */
  async deleteApp(credentialId: string, userId: string): Promise<void> {
    const cred = await this.storage.get(credentialId, userId);
    if (!cred) {
      return; // Idempotent — already deleted
    }

    if (cred.provider !== "slack-app") {
      throw new AppInstallError(
        "CREDENTIAL_NOT_FOUND",
        `Credential ${credentialId} is not a slack-app`,
      );
    }

    const secretResult = SlackAppSecretSchema.safeParse(cred.secret);
    const appId = secretResult.success ? secretResult.data.externalId : undefined;

    if (appId) {
      try {
        const xoxpToken = await this.resolveUserToken(cred, userId);
        const parsed = await callSlackApi(
          "https://slack.com/api/apps.manifest.delete",
          xoxpToken,
          { app_id: appId },
          SlackApiResponseSchema,
          "Manifest delete",
        );
        if (!parsed.ok) {
          this.log.warn("slack_app_delete_remote_api_error", {
            credentialId,
            appId,
            error: parsed.error,
          });
        } else {
          this.log.info("slack_app_deleted_remote", { credentialId, appId });
        }
      } catch (err) {
        this.log.warn("slack_app_delete_remote_failed", {
          credentialId,
          appId,
          error: stringifyError(err),
        });
      }

      try {
        await this.webhookSecrets.delete(appId);
      } catch (err) {
        this.log.warn("slack_app_delete_webhook_secret_failed", {
          credentialId,
          appId,
          error: stringifyError(err),
        });
      }
    }

    try {
      await this.workspaceRepo.deleteByCredentialId(credentialId);
    } catch (err) {
      this.log.warn("slack_app_delete_workspace_mapping_failed", {
        credentialId,
        error: stringifyError(err),
      });
    }

    await this.storage.delete(credentialId, userId);
    this.log.info("slack_app_deleted", { credentialId, appId });
  }

  /** Delete by Slack app ID (resolves to credential, then delegates to deleteApp). Idempotent. */
  async deleteAppByAppId(appId: string, userId: string): Promise<void> {
    const cred = await this.storage.findByProviderAndExternalId("slack-app", appId, userId);
    if (!cred) {
      this.log.debug("slack_app_delete_by_app_id_not_found", { appId, userId });
      return;
    }
    await this.deleteApp(cred.id, userId);
  }

  /** Look up the slack-app credential wired to a workspace, returning credential and app IDs. */
  async resolveByWorkspace(
    workspaceId: string,
    userId: string,
  ): Promise<{ credentialId: string; appId: string } | null> {
    const mapping = await this.workspaceRepo.findByWorkspaceId(workspaceId);
    if (!mapping) return null;

    const cred = await this.storage.get(mapping.credentialId, userId);
    if (!cred || cred.provider !== "slack-app") return null;

    const secretResult = SlackAppSecretSchema.safeParse(cred.secret);
    if (!secretResult.success) return null;

    return { credentialId: cred.id, appId: secretResult.data.externalId };
  }

  /** Find a slack-app credential that is NOT wired to any workspace and has completed OAuth. */
  async findUnwiredCredential(
    userId: string,
  ): Promise<{ credentialId: string; appId: string } | null> {
    const summaries = await this.storage.list("oauth", userId);

    for (const summary of summaries) {
      if (summary.provider !== "slack-app") continue;

      const mapping = await this.workspaceRepo.findByCredentialId(summary.id);
      if (mapping) continue;

      const cred = await this.storage.get(summary.id, userId);
      if (!cred) continue;

      const secretResult = SlackAppSecretSchema.safeParse(cred.secret);
      if (!secretResult.success) continue;
      if (secretResult.data.access_token === PENDING_TOKEN) continue;

      return { credentialId: cred.id, appId: secretResult.data.externalId };
    }

    return null;
  }

  /** Resolve the xoxp- user token from the linked slack-user credential. */
  private async resolveUserToken(cred: Credential, userId: string): Promise<string> {
    const secret = SlackAppSecretSchema.parse(cred.secret);
    if (!secret.slack) {
      throw new AppInstallError("CREDENTIAL_NOT_FOUND", "Credential missing slackUserCredentialId");
    }

    const userCred = await this.storage.get(secret.slack.slackUserCredentialId, userId);
    if (!userCred) {
      throw new AppInstallError(
        "CREDENTIAL_NOT_FOUND",
        `Slack user credential not found: ${secret.slack.slackUserCredentialId}`,
      );
    }

    const userSecret = AccessTokenSecretSchema.safeParse(userCred.secret);
    if (!userSecret.success) {
      throw new AppInstallError(
        "CREDENTIAL_NOT_FOUND",
        "Slack user credential missing access_token",
      );
    }

    return userSecret.data.access_token;
  }

  /** Export current manifest for a Slack app. */
  private async exportManifest(appId: string, xoxpToken: string): Promise<Record<string, unknown>> {
    const parsed = await callSlackApi(
      "https://slack.com/api/apps.manifest.export",
      xoxpToken,
      { app_id: appId },
      ManifestExportResponseSchema,
      "Manifest export",
    );
    if (!parsed.ok) {
      throw new AppInstallError(
        "SLACK_API_ERROR",
        `Manifest export failed: ${parsed.error ?? "unknown"}`,
      );
    }
    return parsed.manifest;
  }
}
