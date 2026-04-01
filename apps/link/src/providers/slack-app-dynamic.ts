/** Reads client_id/client_secret from the incomplete credential, not env vars. */

import { randomBytes } from "node:crypto";
import { stringifyError } from "@atlas/utils";
import { z } from "zod";
import type { WebhookSecretRepository } from "../adapters/webhook-secret-repository.ts";
import { decodeAppInstallState, encodeAppInstallState } from "../app-install/app-state.ts";
import { AppInstallError } from "../app-install/errors.ts";
import { BOT_SCOPES, buildManifest, PENDING_TOKEN } from "../slack-apps/manifest.ts";
import { SlackAppSecretSchema } from "../slack-apps/service.ts";
import { callSlackApi } from "../slack-apps/slack-api-client.ts";
import type { StorageAdapter } from "../types.ts";
import { defineAppInstallProvider } from "./types.ts";

/** @see https://api.slack.com/methods/oauth.v2.access */
const SlackOAuthSuccessSchema = z
  .object({
    ok: z.literal(true),
    access_token: z.string().startsWith("xoxb-"),
    token_type: z.literal("bot"),
    scope: z.string().default(""),
    bot_user_id: z.string(),
    app_id: z.string(),
    team: z.object({ id: z.string(), name: z.string() }),
    authed_user: z.object({ id: z.string() }).optional(),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
  })
  .passthrough();

const SlackOAuthErrorSchema = z
  .object({ ok: z.literal(false), error: z.string().optional() })
  .passthrough();

const SlackOAuthResponseSchema = z.discriminatedUnion("ok", [
  SlackOAuthSuccessSchema,
  SlackOAuthErrorSchema,
]);

const SlackAuthTestResponseSchema = z
  .object({ ok: z.boolean(), team: z.string().optional(), error: z.string().optional() })
  .passthrough();

/** @see https://api.slack.com/methods/apps.manifest.create */
const ManifestCreateSuccessSchema = z.object({
  ok: z.literal(true),
  app_id: z.string(),
  credentials: z.object({
    client_id: z.string(),
    client_secret: z.string(),
    signing_secret: z.string(),
    verification_token: z.string(),
  }),
  oauth_authorize_url: z.string(),
});
const ManifestCreateResponseSchema = z.discriminatedUnion("ok", [
  ManifestCreateSuccessSchema,
  z.object({ ok: z.literal(false), error: z.string().optional() }).passthrough(),
]);

const AccessTokenSecretSchema = z.object({ access_token: z.string() });

/**
 * Find an existing incomplete (unwired, pending-token) slack-app credential.
 * Returns credential ID + app ID if found, null otherwise.
 */
async function findIncompleteCredential(
  st: StorageAdapter,
  userId: string,
): Promise<{ credentialId: string; appId: string } | null> {
  const credentials = await st.list("oauth", userId);
  for (const c of credentials) {
    if (c.provider !== "slack-app") continue;
    const full = await st.get(c.id, userId);
    if (!full) continue;
    const secretResult = SlackAppSecretSchema.safeParse(full.secret);
    if (!secretResult.success) continue;
    if (secretResult.data.access_token !== PENDING_TOKEN) continue;
    return { credentialId: c.id, appId: secretResult.data.externalId };
  }

  return null;
}

export function createSlackAppDynamicProvider(
  storage: StorageAdapter,
  webhookSecrets: WebhookSecretRepository,
) {
  return defineAppInstallProvider({
    id: "slack-app",
    platform: "slack",
    usesRouteTable: false,
    displayName: "Slack Bot",
    description: "Install a Slack bot for this workspace",

    async buildAuthorizationUrl(callbackUrl, state) {
      const decoded = await decodeAppInstallState(state);
      const userId = decoded.u;
      if (!userId) {
        throw new AppInstallError("INVALID_CREDENTIAL", "Missing userId in app-install state");
      }

      // Idempotency: reuse existing incomplete credential
      const existing = await findIncompleteCredential(storage, userId);
      if (existing) {
        const newState = await encodeAppInstallState({
          p: "slack-app",
          r: decoded.r,
          u: userId,
          c: existing.credentialId,
        });

        const cred = await storage.get(existing.credentialId, userId);
        const secret = SlackAppSecretSchema.parse(cred?.secret);
        if (!secret.slack) {
          throw new AppInstallError("INVALID_CREDENTIAL", "Incomplete credential missing clientId");
        }

        const url = new URL("https://slack.com/oauth/v2/authorize");
        url.searchParams.set("client_id", secret.slack.clientId);
        url.searchParams.set("scope", BOT_SCOPES.join(","));
        url.searchParams.set("redirect_uri", callbackUrl);
        url.searchParams.set("state", newState);
        return url.toString();
      }

      // Find the user's slack-user credential
      const allCreds = await storage.list("oauth", userId);
      const slackUserCred = allCreds.find((c) => c.provider === "slack-user");
      if (!slackUserCred) {
        throw new AppInstallError(
          "CREDENTIAL_NOT_FOUND",
          "No slack-user credential found — connect Slack Organization first",
        );
      }

      const fullCred = await storage.get(slackUserCred.id, userId);
      const userSecret = AccessTokenSecretSchema.safeParse(fullCred?.secret);
      if (!userSecret.success) {
        throw new AppInstallError(
          "CREDENTIAL_NOT_FOUND",
          "Slack user credential missing access_token",
        );
      }

      // Create the Slack app via manifest API
      const suffix = randomBytes(2).toString("hex");
      const manifest = buildManifest({
        appName: `Friday ${suffix}`,
        description: "Friday AI agent",
        callbackUrl,
      });

      const parsed = await callSlackApi(
        "https://slack.com/api/apps.manifest.create",
        userSecret.data.access_token,
        { manifest },
        ManifestCreateResponseSchema,
        "Manifest creation",
      );
      if (!parsed.ok) {
        throw new AppInstallError(
          "SLACK_API_ERROR",
          `Slack manifest creation failed: ${parsed.error ?? "unknown error"}`,
        );
      }

      await webhookSecrets.insert(parsed.app_id, userId, parsed.credentials.signing_secret);

      // Save incomplete credential with pending token
      const { id: credentialId } = await storage.save(
        {
          type: "oauth",
          provider: "slack-app",
          label: `Slack Bot (${parsed.app_id})`,
          secret: {
            platform: "slack" as const,
            externalId: parsed.app_id,
            access_token: PENDING_TOKEN,
            slack: {
              clientId: parsed.credentials.client_id,
              clientSecret: parsed.credentials.client_secret,
              slackUserCredentialId: slackUserCred.id,
            },
          },
        },
        userId,
      );

      // Re-encode state with the new credentialId so completeInstallation can find it
      const newState = await encodeAppInstallState({
        p: "slack-app",
        r: decoded.r,
        u: userId,
        c: credentialId,
      });

      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", parsed.credentials.client_id);
      url.searchParams.set("scope", BOT_SCOPES.join(","));
      url.searchParams.set("redirect_uri", callbackUrl);
      url.searchParams.set("state", newState);
      return url.toString();
    },

    async completeInstallation(code, callbackUrl, callbackParams) {
      if (!code) {
        throw new AppInstallError("MISSING_CODE", "No authorization code provided");
      }

      const credentialId = callbackParams?.get("credential_id");
      if (!credentialId) {
        throw new AppInstallError("INVALID_CREDENTIAL", "Missing credential_id in callback params");
      }

      const userId = callbackParams?.get("user_id");
      if (!userId) {
        throw new AppInstallError("INVALID_CREDENTIAL", "Missing user_id in callback params");
      }

      const credential = await storage.get(credentialId, userId);
      if (!credential || credential.provider !== "slack-app") {
        throw new AppInstallError(
          "CREDENTIAL_NOT_FOUND",
          `Incomplete slack-app credential not found: ${credentialId}`,
        );
      }

      const secretResult = SlackAppSecretSchema.safeParse(credential.secret);
      if (!secretResult.success) {
        throw new AppInstallError(
          "INVALID_CREDENTIAL",
          "Incomplete credential missing client credentials",
        );
      }
      const secret = secretResult.data;
      const { slack } = secret;
      if (!slack) {
        throw new AppInstallError(
          "INVALID_CREDENTIAL",
          "Incomplete credential missing client credentials",
        );
      }

      let resp: Response;
      try {
        resp = await fetch("https://slack.com/api/oauth.v2.access", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${btoa(`${slack.clientId}:${slack.clientSecret}`)}`,
          },
          body: new URLSearchParams({ code, redirect_uri: callbackUrl }),
        });
      } catch (err) {
        throw new AppInstallError(
          "SLACK_NETWORK_ERROR",
          `Network error calling Slack: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!resp.ok) {
        throw new AppInstallError("SLACK_HTTP_ERROR", `Slack OAuth returned HTTP ${resp.status}`);
      }

      const raw: unknown = await resp.json().catch(() => {
        throw new AppInstallError("SLACK_PARSE_ERROR", "Invalid JSON from Slack");
      });

      const parsed = SlackOAuthResponseSchema.parse(raw);
      if (!parsed.ok) {
        throw new AppInstallError("SLACK_OAUTH_ERROR", parsed.error ?? "Unknown Slack OAuth error");
      }

      return {
        externalId: secret.externalId,
        externalName: parsed.team.name,
        credential: {
          type: "oauth" as const,
          provider: "slack-app",
          label: `${parsed.team.name} (${secret.externalId})`,
          secret: {
            platform: "slack" as const,
            externalId: secret.externalId,
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token,
            expires_at: parsed.expires_in
              ? Math.floor(Date.now() / 1000) + parsed.expires_in
              : undefined,
            slack: {
              clientId: slack.clientId,
              clientSecret: slack.clientSecret,
              slackUserCredentialId: slack.slackUserCredentialId ?? "",
            },
          },
        },
      };
    },

    async healthCheck(secret) {
      try {
        const resp = await fetch("https://slack.com/api/auth.test", {
          method: "POST",
          headers: { Authorization: `Bearer ${secret.access_token}` },
        });

        const raw: unknown = await resp.json().catch(() => {
          throw new Error("Invalid JSON from Slack auth.test");
        });

        const data = SlackAuthTestResponseSchema.parse(raw);

        return data.ok
          ? { healthy: true, metadata: { team: data.team } }
          : { healthy: false, error: data.error ?? "Unknown auth error" };
      } catch (err) {
        return { healthy: false, error: stringifyError(err) };
      }
    },
  });
}
