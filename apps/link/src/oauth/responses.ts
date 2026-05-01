/**
 * OAuth Flow Response Helpers
 * JSON responses for OAuth flow completion when no redirect_uri provided
 */

import type { Context } from "hono";

/**
 * Render success response for completed OAuth flow
 */
export function renderSuccessResponse(c: Context, provider: string, credentialId: string) {
  return c.json({ status: "success", provider, credential_id: credentialId }, 200);
}

/**
 * Render error response for failed OAuth flow
 */
export function renderErrorResponse(c: Context, error: string, errorDescription?: string) {
  return c.json({ status: "error", error, error_description: errorDescription }, 400);
}
