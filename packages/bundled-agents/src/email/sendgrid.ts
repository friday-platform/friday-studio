/**
 * SendGrid email sending functionality
 *
 * Simplified SendGrid integration extracted from @atlas/notifications
 * with only the functionality needed for the email agent.
 */

import type { EmailParams } from "@atlas/config";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { classes } from "@sendgrid/helpers";
import sgMail from "@sendgrid/mail";
import { RetryError, retry } from "@std/async/retry";
import { z } from "zod";

const { ResponseError } = classes;

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

const MAX_ATTEMPTS = 10;

/**
 * Send email via SendGrid with retry logic
 */
export async function sendEmail(
  apiKey: string,
  params: EmailParams,
  options?: { sandboxMode?: boolean },
) {
  sgMail.setApiKey(apiKey);

  let attemptCount = 0;

  try {
    const response = await retry(
      async () => {
        attemptCount++;
        try {
          return await sgMail.send(buildEmailMessage(params, options?.sandboxMode));
        } catch (error) {
          // Log each retry attempt
          if (error instanceof ResponseError) {
            logger.error(`SendGrid attempt ${attemptCount}/${MAX_ATTEMPTS} failed`, {
              code: error.code,
              body: error.response.body,
              headers: error.response.headers,
              attempt: attemptCount,
            });
          } else {
            logger.error(`SendGrid attempt ${attemptCount}/${MAX_ATTEMPTS} failed`, {
              error,
              attempt: attemptCount,
            });
          }
          throw error;
        }
      },
      { maxAttempts: MAX_ATTEMPTS, minTimeout: 5000, maxTimeout: 20000, multiplier: 2 },
    );

    return response;
  } catch (error) {
    let message: string;
    // Retry attempts exhausted
    if (error instanceof RetryError) {
      // Error from SendGrid API
      if (error.cause instanceof ResponseError) {
        logger.error("SendGrid API Error - retry attempts exhausted", {
          code: error.cause.code,
          body: error.cause.response.body,
          headers: error.cause.response.headers,
        });
        message = error.cause.message;
      } else {
        // Something else failed inside the retry
        logger.error("SendGrid retry attempts exhausted", { error: error.cause });
        message = error.message;
      }
    } else {
      // Something else failed inside sendEmail outside the retry
      logger.error("Failed to send email", { error });
      message = stringifyError(error);
    }
    throw new Error(`Failed to send email after ${MAX_ATTEMPTS} attempts: ${message}`);
  }
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
  if (params.content.includes("<!DOCTYPE html>")) {
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
