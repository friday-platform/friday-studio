/**
 * Unified Callback Routes
 * Provider-namespaced OAuth callbacks for better URL readability
 *
 * Pattern: /v1/callback/:provider (e.g., /v1/callback/slack, /v1/callback/google-calendar)
 */

import { logger } from "@atlas/logger";
import { verify } from "hono/jwt";
import { z } from "zod";
import { AppInstallError } from "../app-install/errors.ts";
import type { AppInstallService } from "../app-install/service.ts";
import { factory } from "../factory.ts";
import { STATE_JWT_SECRET } from "../oauth/jwt-secret.ts";
import { renderErrorResponse, renderSuccessResponse } from "../oauth/responses.ts";
import type { OAuthService } from "../oauth/service.ts";

/**
 * Minimal state schema to detect flow type and extract redirect URI.
 * App-install flows have k="app_install", OAuth flows don't have k.
 */
const FlowTypeSchema = z.object({
  k: z.literal("app_install").optional(),
  p: z.string(), // providerId - used to validate URL matches state
  r: z.string().optional(), // redirectUri - where to send user on error
});

const CallbackQuerySchema = z.object({
  state: z.string().min(1),
  code: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

/**
 * Create unified callback router.
 * Routes to appropriate handler based on state JWT contents.
 *
 * @param oauthService - OAuth service for standard OAuth flows
 * @param appInstallService - App install service for Slack/GitHub app flows
 */
export function createCallbackRoutes(
  oauthService: OAuthService,
  appInstallService: AppInstallService,
) {
  return factory.createApp().get("/:provider", async (c) => {
    const provider = c.req.param("provider");
    const rawQuery = c.req.query();

    // Parse query params
    const query = CallbackQuerySchema.safeParse(rawQuery);
    if (!query.success) {
      return renderErrorResponse(c, "invalid_query", query.error.message);
    }

    const { state, code, error, error_description } = query.data;

    // Decode state to get flow type and redirectUri
    let flowType: z.infer<typeof FlowTypeSchema>;
    try {
      const payload = await verify(state, STATE_JWT_SECRET, "HS256");
      flowType = FlowTypeSchema.parse(payload);
    } catch {
      return renderErrorResponse(c, "invalid_state", "OAuth state invalid or expired");
    }

    // Validate provider mismatch FIRST - before any redirects to prevent phishing
    if (flowType.p !== provider) {
      logger.warn("Provider mismatch in callback", {
        urlProvider: provider,
        stateProvider: flowType.p,
      });
      // Don't leak state provider in error message
      return renderErrorResponse(c, "provider_mismatch", "Provider in URL does not match state");
    }

    // Provider returned an error - redirect with error if redirectUri present
    if (error) {
      if (flowType.r) {
        const url = new URL(flowType.r);
        url.searchParams.set("error", error);
        if (error_description) url.searchParams.set("error_description", error_description);
        return c.redirect(url.toString(), 302);
      }
      return renderErrorResponse(c, error, error_description);
    }

    // Extract all callback query params for providers that need them
    const callbackParams = new URLSearchParams(rawQuery);

    try {
      let credential: { id: string; provider: string };
      let redirectUri: string | undefined;

      if (flowType.k === "app_install") {
        // App install service handles no-code cases (reinstall, approval_pending) internally
        ({ credential, redirectUri } = await appInstallService.completeInstall(
          state,
          code,
          callbackParams,
        ));
      } else {
        // OAuth flows require code
        if (!code) {
          return renderErrorResponse(c, "missing_code", "No authorization code in callback");
        }
        ({ credential, redirectUri } = await oauthService.completeFlow(state, code));
      }

      if (redirectUri) {
        const url = new URL(redirectUri);
        url.searchParams.set("credential_id", credential.id);
        url.searchParams.set("provider", credential.provider);
        return c.redirect(url.toString(), 302);
      }

      return renderSuccessResponse(c, credential.provider, credential.id);
    } catch (e) {
      // Surface specific AppInstallError codes (e.g., APPROVAL_PENDING)
      if (e instanceof AppInstallError) {
        logger.info("app_install_error", { code: e.code, message: e.message });
        return renderErrorResponse(c, e.code.toLowerCase(), e.message);
      }

      const isAppInstall = flowType.k === "app_install";
      const errorCode = isAppInstall ? "app_install_failed" : "oauth_completion_failed";
      logger.error(errorCode, { error: e });
      return renderErrorResponse(
        c,
        errorCode,
        `Failed to complete ${isAppInstall ? "app installation" : "OAuth flow"}`,
      );
    }
  });
}
