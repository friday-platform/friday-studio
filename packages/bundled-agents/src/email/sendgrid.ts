import { hostname } from "node:os";
import process from "node:process";
import type { EmailParams } from "@atlas/config";
import { z } from "zod";

const AtlasJWTPayloadSchema = z.object({
  email: z.email().optional(),
  iss: z.literal("tempest-atlas").optional(),
  sub: z.string(),
  exp: z.number(),
  iat: z.number(),
});

export async function sendEmail(
  params: EmailParams,
  options?: { sandboxMode?: boolean; workspaceId?: string },
) {
  const gatewayUrl = process.env.FRIDAY_GATEWAY_URL;
  if (!gatewayUrl) {
    throw new Error("FRIDAY_GATEWAY_URL not set");
  }

  const atlasKey = process.env.FRIDAY_KEY;
  if (!atlasKey) {
    throw new Error("FRIDAY_KEY not set");
  }

  const customHeaders = buildCustomHeaders(options?.workspaceId);

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
      from: params.from || "notifications@hellofriday.ai",
      from_name: params.from_name,
      subject: params.subject,
      content: params.content,
      template_id: params.template_id,
      template_data: params.template_data,
      attachments: params.attachments,
      sandbox_mode: options?.sandboxMode ?? false,
      client_hostname: clientHostname,
      custom_headers: customHeaders,
      workspace_id: options?.workspaceId,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gateway error: ${response.status} ${error}`);
  }

  return response;
}

function buildCustomHeaders(workspaceId?: string): Record<string, string> {
  const headers: Record<string, string> = {};

  const userEmail = process.env.FRIDAY_KEY ? extractUserFromJWT(process.env.FRIDAY_KEY) : null;
  if (userEmail) {
    headers["X-Atlas-User"] = userEmail;
  }

  if (workspaceId) {
    headers["X-Friday-Workspace"] = workspaceId;
  }

  return headers;
}

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
