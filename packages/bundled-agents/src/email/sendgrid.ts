/**
 * SendGrid email sending functionality
 *
 * Simplified SendGrid integration extracted from @atlas/notifications
 * with only the functionality needed for the email agent.
 */

import { hostname } from "node:os";
import process from "node:process";
import type { EmailParams } from "@atlas/config";
import { z } from "zod";

/**
 * Atlas JWT payload schema for extracting user email
 */
const AtlasJWTPayloadSchema = z.object({
  email: z.email().optional(),
  iss: z.literal("tempest-atlas").optional(),
  sub: z.string(),
  exp: z.number(),
  iat: z.number(),
});

/**
 * Send email via Gateway
 */
export async function sendEmail(params: EmailParams, options?: { sandboxMode?: boolean }) {
  const gatewayUrl = process.env.FRIDAY_GATEWAY_URL;
  if (!gatewayUrl) {
    throw new Error("FRIDAY_GATEWAY_URL not set");
  }

  const atlasKey = process.env.ATLAS_KEY;
  if (!atlasKey) {
    throw new Error("ATLAS_KEY not set");
  }

  // Build custom headers
  const customHeaders = buildCustomHeaders();

  // Get client hostname for tracking
  let clientHostname: string | undefined;
  try {
    clientHostname = hostname().toLowerCase();
  } catch {
    // hostname() can fail in some environments
  }

  const response = await fetch(`${gatewayUrl}/v1/sendgrid/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${atlasKey}` },
    body: JSON.stringify({
      to: params.to,
      from: params.from || "noreply@hellofriday.ai",
      from_name: params.from_name,
      subject: params.subject,
      content: params.content,
      template_id: params.template_id,
      template_data: params.template_data,
      attachments: params.attachments,
      sandbox_mode: options?.sandboxMode ?? false,
      client_hostname: clientHostname,
      custom_headers: customHeaders,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gateway error: ${response.status} ${error}`);
  }

  return response;
}

/**
 * Build custom headers for Atlas tracking
 */
function buildCustomHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  // Add user email header if available
  const userEmail = process.env.ATLAS_KEY ? extractUserFromJWT(process.env.ATLAS_KEY) : null;
  if (userEmail) {
    headers["X-Atlas-User"] = userEmail;
  }

  return headers;
}

/**
 * Extract user email from JWT token
 */
export function extractUserFromJWT(token: string): string | null {
  try {
    const payload = JSON.parse(
      atob((token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")),
    );
    const result = AtlasJWTPayloadSchema.safeParse(payload);
    return result.success ? (result.data.email ?? null) : null;
  } catch {
    return null;
  }
}
