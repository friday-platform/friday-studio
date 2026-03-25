import { logger } from "@atlas/logger";
import { z } from "zod";
import { AppInstallError } from "../app-install/errors.ts";
import { type AppInstallProvider, defineAppInstallProvider } from "./types.ts";

/**
 * User-scope flow: token is in authed_user.access_token (not top-level).
 * @see https://api.slack.com/methods/oauth.v2.access
 */
const SlackUserOAuthSuccessSchema = z
  .object({
    ok: z.literal(true),
    team: z.object({ id: z.string(), name: z.string() }),
    authed_user: z.object({ id: z.string(), access_token: z.string().startsWith("xoxp-") }),
  })
  .passthrough();

const SlackUserOAuthErrorSchema = z
  .object({ ok: z.literal(false), error: z.string().optional() })
  .passthrough();

const SlackUserOAuthResponseSchema = z.discriminatedUnion("ok", [
  SlackUserOAuthSuccessSchema,
  SlackUserOAuthErrorSchema,
]);

/** Slack user-token provider for manifest API access (user_scope=app_configurations:write,read). */
export function createSlackUserProvider(credentials: {
  clientId: string | undefined;
  clientSecret: string | undefined;
}): AppInstallProvider | undefined {
  const { clientId, clientSecret } = credentials;

  if (!clientId || !clientSecret) {
    logger.debug("slack-user provider not configured (missing client credentials)");
    return undefined;
  }

  return defineAppInstallProvider({
    id: "slack-user",
    platform: "slack",
    usesRouteTable: false,
    displayName: "Slack Organization",
    description: "Connect your Slack organization to manage bots",

    buildAuthorizationUrl(callbackUrl, state) {
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("user_scope", "app_configurations:write,app_configurations:read");
      url.searchParams.set("redirect_uri", callbackUrl);
      url.searchParams.set("state", state);
      return Promise.resolve(url.toString());
    },

    async completeInstallation(code, callbackUrl) {
      if (!code) {
        throw new AppInstallError("MISSING_CODE", "No authorization code provided");
      }

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

      const raw: unknown = await resp.json().catch(() => {
        throw new AppInstallError("SLACK_PARSE_ERROR", "Invalid JSON from Slack");
      });

      const parsed = SlackUserOAuthResponseSchema.parse(raw);
      if (!parsed.ok) {
        throw new AppInstallError("SLACK_OAUTH_ERROR", parsed.error ?? "Unknown Slack OAuth error");
      }

      return {
        externalId: parsed.team.id,
        externalName: parsed.team.name,
        credential: {
          type: "oauth",
          provider: "slack-user",
          label: parsed.team.name,
          secret: {
            platform: "slack-user" as const,
            access_token: parsed.authed_user.access_token,
            team_id: parsed.team.id,
            team_name: parsed.team.name,
            user_id: parsed.authed_user.id,
          },
        },
      };
    },
  });
}
