import { readFileSync } from "node:fs";
import { env } from "node:process";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { z } from "zod";
import { AppInstallError } from "../app-install/errors.ts";
import type { AppInstallProvider } from "./types.ts";
import { defineAppInstallProvider } from "./types.ts";

/**
 * Slack OAuth success response schema.
 * @see https://api.slack.com/methods/oauth.v2.access
 */
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
    // Token rotation fields (optional)
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
  })
  .passthrough();

/**
 * Slack OAuth error response schema.
 * @see https://api.slack.com/methods/oauth.v2.access
 */
const SlackOAuthErrorSchema = z
  .object({ ok: z.literal(false), error: z.string().optional() })
  .passthrough();

/**
 * Discriminated union for Slack OAuth responses.
 */
const SlackOAuthResponseSchema = z.discriminatedUnion("ok", [
  SlackOAuthSuccessSchema,
  SlackOAuthErrorSchema,
]);

/**
 * Slack auth.test response schema.
 * @see https://api.slack.com/methods/auth.test
 */
const SlackAuthTestResponseSchema = z
  .object({ ok: z.boolean(), team: z.string().optional(), error: z.string().optional() })
  .passthrough();

/** Required bot scopes for Atlas Slack integration */
const SLACK_BOT_SCOPES = [
  "chat:write",
  "channels:history",
  "channels:read",
  "app_mentions:read",
] as const;

/**
 * Creates a Slack App Install provider.
 * Returns undefined if required environment variables are not set.
 *
 * Required environment variables:
 * - SLACK_APP_CLIENT_ID_FILE: Path to file containing Slack OAuth client ID
 * - SLACK_APP_CLIENT_SECRET_FILE: Path to file containing Slack OAuth client secret
 *
 * @returns AppInstallProvider for Slack workspace installations, or undefined if not configured
 */
export function createSlackAppInstallProvider(): AppInstallProvider | undefined {
  const clientIdFile = env.SLACK_APP_CLIENT_ID_FILE;
  const clientSecretFile = env.SLACK_APP_CLIENT_SECRET_FILE;

  if (!clientIdFile || !clientSecretFile) {
    logger.debug(
      "Slack app install provider not configured (missing SLACK_APP_CLIENT_ID_FILE or SLACK_APP_CLIENT_SECRET_FILE)",
    );
    return undefined;
  }

  let clientId: string;
  let clientSecret: string;

  try {
    clientId = readFileSync(clientIdFile, "utf-8").trim();
    clientSecret = readFileSync(clientSecretFile, "utf-8").trim();
  } catch (err) {
    logger.warn(`Failed to read Slack app credentials: ${stringifyError(err)}`);
    return undefined;
  }

  return defineAppInstallProvider({
    id: "slack",
    platform: "slack",
    displayName: "Slack",
    description: "Install Atlas bot into a Slack workspace",
    docsUrl: "https://api.slack.com/apps",

    buildAuthorizationUrl(callbackUrl, state) {
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
      url.searchParams.set("redirect_uri", callbackUrl);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async completeInstallation(code, callbackUrl) {
      let resp: Response;
      try {
        resp = await fetch("https://slack.com/api/oauth.v2.access", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
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

      const raw = await resp.json().catch(() => {
        throw new AppInstallError("SLACK_PARSE_ERROR", "Invalid JSON from Slack");
      });

      const parsed = SlackOAuthResponseSchema.parse(raw);
      if (!parsed.ok) {
        throw new AppInstallError("SLACK_OAUTH_ERROR", parsed.error ?? "Unknown Slack OAuth error");
      }

      const data = parsed;

      return {
        externalId: data.team.id,
        externalName: data.team.name,
        credential: {
          type: "oauth",
          provider: "slack",
          label: data.team.name,
          secret: {
            externalId: data.team.id, // Stored for reconcileRoute
            access_token: data.access_token,
            token_type: "bot",
            refresh_token: data.refresh_token,
            expires_at: data.expires_in
              ? Math.floor(Date.now() / 1000) + data.expires_in
              : undefined,
            slack: {
              botUserId: data.bot_user_id,
              appId: data.app_id,
              teamId: data.team.id,
              teamName: data.team.name,
              scopes: data.scope
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
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

        const raw = await resp.json().catch(() => {
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

    async refreshToken(refreshToken) {
      let resp: Response;
      try {
        resp = await fetch("https://slack.com/api/oauth.v2.access", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
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

      const raw = await resp.json().catch(() => {
        throw new AppInstallError("SLACK_PARSE_ERROR", "Invalid JSON from Slack");
      });

      const parsed = SlackOAuthResponseSchema.parse(raw);
      if (!parsed.ok) {
        throw new AppInstallError(
          "SLACK_REFRESH_ERROR",
          parsed.error ?? "Unknown Slack refresh error",
        );
      }

      // Slack always returns refresh_token and expires_in on refresh
      if (!parsed.refresh_token || !parsed.expires_in) {
        throw new AppInstallError(
          "SLACK_REFRESH_ERROR",
          "Slack refresh response missing required fields",
        );
      }

      return {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expires_in: parsed.expires_in,
      };
    },
  });
}
