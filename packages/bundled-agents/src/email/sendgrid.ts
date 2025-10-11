/**
 * SendGrid email sending functionality
 *
 * Simplified SendGrid integration extracted from @atlas/notifications
 * with only the functionality needed for the email agent.
 */

import { retry } from "jsr:@std/async@1/retry";
import type { EmailParams } from "@atlas/config";
import sgMail from "@sendgrid/mail";
import { z } from "zod";

/**
 * SendGrid send result
 */
export type SendResult = { message_id?: string; retry_count: number };

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
 * Send email via SendGrid with retry logic
 */
export async function sendEmail(
  apiKey: string,
  params: EmailParams,
  options?: { sandboxMode?: boolean },
): Promise<SendResult> {
  sgMail.setApiKey(apiKey);

  let attemptCount = 0;

  const response = await retry(
    async () => {
      attemptCount++;
      try {
        const message = buildEmailMessage(params, options?.sandboxMode);
        return await sgMail.send(message);
      } catch (error) {
        // Non-retryable errors should fail immediately
        if (!isRetryableError(error)) {
          throw new Error(
            `Non-retryable error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        throw error;
      }
    },
    {
      maxAttempts: 3,
      minTimeout: 5000,
      maxTimeout: 20000, // 5s * 2^2
      multiplier: 2,
    },
  );

  return { message_id: response[0]?.headers?.["x-message-id"], retry_count: attemptCount - 1 };
}

/**
 * Build SendGrid email message from parameters
 */
function buildEmailMessage(params: EmailParams, sandboxMode = false): sgMail.MailDataRequired {
  const message: Partial<sgMail.MailDataRequired> = {
    to: params.to,
    from: params.from || "noreply@tempestdx.com",
    subject: params.subject,
  };

  // Add content
  if (params.content.includes("<html>") || params.content.includes("<body>")) {
    message.html = params.content;
  } else {
    message.text = params.content;
  }

  // Add template support
  if (params.template_id) {
    message.templateId = params.template_id;
    if (params.template_data) {
      message.dynamicTemplateData = params.template_data;
    }
  }

  // Add attachments if present
  if (params.attachments && params.attachments.length > 0) {
    message.attachments = params.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      type: attachment.type,
      disposition: attachment.disposition,
    }));
  }

  // Add sandbox mode if enabled
  if (sandboxMode) {
    message.mailSettings = { sandboxMode: { enable: true } };
  }

  // Always use 'tempest-atlas' IP pool
  message.ipPoolName = "tempest-atlas";

  // Add custom Atlas tracking headers
  message.headers = buildCustomHeaders();

  return message as sgMail.MailDataRequired;
}

/**
 * Build custom headers for Atlas tracking
 */
function buildCustomHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  // Add hostname (always lowercase)
  try {
    headers["X-Atlas-Hostname"] = Deno.hostname().toLowerCase();
  } catch {
    headers["X-Atlas-Hostname"] = "unknown";
  }

  // Add user from Atlas key if available
  const atlasKey = Deno.env.get("ATLAS_KEY");
  if (atlasKey) {
    const userEmail = extractUserFromJWT(atlasKey);
    if (userEmail) {
      headers["X-Atlas-User"] = userEmail;
    }
  }

  return headers;
}

/**
 * Extract user email from JWT token
 */
function extractUserFromJWT(token: string): string | null {
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

/**
 * Check if error is retryable
 */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message;

  // Retryable: rate limits, server errors, network issues
  return (
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    error.name === "NetworkError" ||
    error.name === "TimeoutError" ||
    message.includes("ECONNRESET") ||
    message.includes("ENOTFOUND") ||
    message.includes("ETIMEDOUT")
  );
}
