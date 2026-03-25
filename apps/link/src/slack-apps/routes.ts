/** HTTP endpoints for Slack app lifecycle. */

import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { z } from "zod";
import { AppInstallError, type AppInstallErrorCode } from "../app-install/errors.ts";
import { factory } from "../factory.ts";
import type { SlackAppService } from "./service.ts";

const EventSubscriptionRequestSchema = z.object({ enable: z.boolean() });

function statusForError(code: AppInstallErrorCode): 400 | 404 | 502 | undefined {
  switch (code) {
    case "CREDENTIAL_NOT_FOUND":
      return 404;
    case "CREDENTIAL_INCOMPLETE":
    case "INVALID_CREDENTIAL":
      return 400;
    case "SLACK_API_ERROR":
    case "SLACK_NETWORK_ERROR":
      return 502;
    default:
      return undefined;
  }
}

function handleError(c: Context, e: unknown, fallbackLabel: string) {
  if (e instanceof AppInstallError) {
    const status = statusForError(e.code) ?? 500;
    return c.json({ error: e.code, message: e.message }, status);
  }
  const message = e instanceof Error ? e.message : "Unknown error";
  return c.json({ error: fallbackLabel, message }, 500);
}

const WireRequestSchema = z.object({
  workspace_id: z.string().min(1),
  workspace_name: z.string().min(1),
  workspace_description: z.string().optional(),
});

/** Mounted at /internal/v1/slack-apps. */
export function createInternalSlackAppRoutes(service: SlackAppService, gatewayBase?: string) {
  return factory
    .createApp()
    .post(
      "/:credential_id/events",
      zValidator("json", EventSubscriptionRequestSchema),
      async (c) => {
        const credentialId = c.req.param("credential_id");
        const { enable } = c.req.valid("json");
        const userId = c.get("userId");

        try {
          const result = await service.updateEventSubscriptions(
            credentialId,
            userId,
            enable,
            gatewayBase,
          );

          switch (result.status) {
            case "pending":
              return c.json({ enabled: false, reason: "pending" });
            case "enabled":
              return c.json({ enabled: true, webhook_url: result.webhookUrl });
            case "disabled":
              return c.json({ enabled: false });
          }
        } catch (e) {
          return handleError(c, e, "event_subscription_failed");
        }
      },
    )
    .post("/:credential_id/wire", zValidator("json", WireRequestSchema), async (c) => {
      const credentialId = c.req.param("credential_id");
      const { workspace_id, workspace_name, workspace_description } = c.req.valid("json");
      const userId = c.get("userId");

      try {
        const appId = await service.wireToWorkspace(
          credentialId,
          userId,
          workspace_id,
          workspace_name,
          workspace_description,
        );

        return c.json({ ok: true, app_id: appId });
      } catch (e) {
        return handleError(c, e, "slack_app_wire_failed");
      }
    })
    .get("/by-workspace/:workspace_id", async (c) => {
      const workspaceId = c.req.param("workspace_id");
      const userId = c.get("userId");

      const result = await service.resolveByWorkspace(workspaceId, userId);
      if (!result) {
        return c.json({ error: "NOT_FOUND" }, 404);
      }

      return c.json({ credential_id: result.credentialId, app_id: result.appId });
    })
    .get("/unwired", async (c) => {
      const userId = c.get("userId");

      const result = await service.findUnwiredCredential(userId);
      if (!result) {
        return c.json({ error: "NOT_FOUND" }, 404);
      }

      return c.json({ credential_id: result.credentialId, app_id: result.appId });
    })
    .delete("/by-app-id/:app_id", async (c) => {
      const appId = c.req.param("app_id");
      const userId = c.get("userId");

      try {
        await service.deleteAppByAppId(appId, userId);
        return c.body(null, 204);
      } catch (e) {
        return handleError(c, e, "slack_app_deletion_failed");
      }
    });
}

/** Mounted at /v1/slack-apps. */
export function createSlackAppRoutes(service: SlackAppService) {
  return factory.createApp().delete("/:credential_id", async (c) => {
    const credentialId = c.req.param("credential_id");
    const userId = c.get("userId");

    try {
      await service.deleteApp(credentialId, userId);
      return c.body(null, 204);
    } catch (e) {
      return handleError(c, e, "slack_app_deletion_failed");
    }
  });
}
