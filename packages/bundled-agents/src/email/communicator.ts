import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { contentType } from "jsr:@std/media-types@1";
import { resolve } from "jsr:@std/path@1";
import { homedir } from "node:os";
import { env } from "node:process";
import { createAgent } from "@atlas/agent-sdk";
import type { EmailParams } from "@atlas/config";
import { anthropic } from "@atlas/core";
import { getTodaysDate } from "@atlas/utils";
import { generateObject } from "ai";
import { z } from "zod";
import { sendEmail } from "./sendgrid.ts";

/**
 * Email Agent
 *
 * Sends email notifications via SendGrid.
 * Takes natural language prompts and extracts email parameters.
 */
type Result = { response: string; message_id?: string; retry_count?: number };

export const emailAgent = createAgent<string, Result>({
  id: "email",
  displayName: "Email",
  version: "1.0.0",
  description:
    "Send email notifications via SendGrid with template support, file attachments, and automatic retry with exponential backoff",
  expertise: {
    domains: ["email", "notifications", "sendgrid"],
    examples: [
      "Send email to john@example.com with subject 'Test' and content 'Hello world'",
      "Email sarah@company.com: subject 'Meeting reminder', message 'Don't forget our 2pm meeting'",
      "Send notification to team@startup.io about deployment completion",
      "Send email to lukasz@tempest.team with subject 'Report' and attach /path/to/report.pdf",
    ],
  },
  environment: {
    required: [
      {
        name: "SENDGRID_API_KEY",
        description: "SendGrid API key for sending emails",
        validation: "^SG\\.",
      },
    ],
    optional: [
      {
        name: "SENDGRID_FROM_EMAIL",
        description: "Default sender email address",
        default: "noreply@tempestdx.com",
      },
      { name: "SENDGRID_FROM_NAME", description: "Default sender name" },
      {
        name: "SENDGRID_SANDBOX_MODE",
        description: "Enable sandbox mode for testing (true/false)",
      },
    ],
  },

  handler: async (prompt, { logger, abortSignal, stream }): Promise<Result> => {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required");
    }

    // Check for required SendGrid environment variables
    const sendGridApiKey = env.SENDGRID_API_KEY;
    if (!sendGridApiKey) {
      throw new Error(
        "SENDGRID_API_KEY environment variable is required. Please set it in your .env file.",
      );
    }

    // Progress: planning
    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Email", content: `Analyzing email request...` },
    });

    // Define schema for email parameter extraction
    const emailParamsSchema = z.object({
      to: z.email().describe("Recipient email address"),
      subject: z.string().min(1).describe("Email subject line"),
      content: z.string().min(1).describe("Email content (HTML or plain text)"),
      from: z.email().nullable().default(null).describe("Sender email address (optional)"),
      from_name: z.string().nullable().default(null).describe("Sender name (optional)"),
      template_id: z.string().nullable().default(null).describe("SendGrid template ID (optional)"),
      template_data: z
        .record(z.string(), z.unknown())
        .nullable()
        .default(null)
        .describe("Template variables (optional)"),
      attachment_paths: z
        .array(z.string())
        .nullable()
        .default(null)
        .describe("File paths to attach to the email (optional)"),
    });

    const extractionSystem = `
You are an email parameter extraction expert. Your job is to extract email parameters from natural language prompts.

Today's date: ${getTodaysDate()}

Extract the following information:
- to: The recipient email address
- subject: The email subject line
- content: The email content/message body
- from: The sender email address (if specified, otherwise null)
- from_name: The sender name (if specified, otherwise null)
- template_id: SendGrid template ID (if specified, otherwise null)
- template_data: Template variables (if specified, otherwise null)
- attachment_paths: Array of file paths to attach (if specified, otherwise null)

Be precise and extract exactly what the user requests. If the user doesn't specify a field, use null.
    `;

    const extractionResult = await generateObject({
      model: anthropic("claude-sonnet-4-20250514"),
      prompt,
      abortSignal,
      system: extractionSystem,
      schema: emailParamsSchema,
      temperature: 0,
      maxOutputTokens: 1000,
    });

    const params = extractionResult.object;
    logger.debug("email-communicator extracted params", { params });

    // Process attachments if provided
    let attachments: EmailParams["attachments"];
    if (params.attachment_paths && params.attachment_paths.length > 0) {
      stream?.emit({
        type: "data-tool-progress",
        data: {
          toolName: "Email",
          content: `Processing ${params.attachment_paths.length} attachment(s)...`,
        },
      });

      attachments = await Promise.all(
        params.attachment_paths.map(async (filePath) => {
          try {
            // Security: Restrict attachments to user home directory
            const homeDir = resolve(homedir());
            const absolutePath = resolve(filePath);

            // Check if path is outside home directory
            if (!absolutePath.startsWith(homeDir)) {
              throw new Error(
                `Security: Attachments must be within user home directory (${homeDir}). Path: ${filePath}`,
              );
            }

            // Validate file exists and is readable
            const stat = await Deno.stat(filePath);

            // Check if it's a file (not directory)
            if (!stat.isFile) {
              throw new Error(`Path is not a file: ${filePath}`);
            }

            // Check file size (SendGrid limit: 30MB total attachments)
            const maxSize = 30 * 1024 * 1024; // 30MB in bytes
            if (stat.size > maxSize) {
              throw new Error(
                `File exceeds 30MB SendGrid limit: ${filePath} (${(stat.size / 1024 / 1024).toFixed(2)}MB)`,
              );
            }

            const content = await Deno.readFile(filePath);
            const base64Content = encodeBase64(content);
            // Handle both Unix (/) and Windows (\) path separators
            const filename = filePath.split(/[/\\]/).pop() || "attachment";

            // Determine MIME type from extension
            const ext = filename.split(".").pop()?.toLowerCase() || "";
            const mimeType = contentType(ext) || "application/octet-stream";

            return {
              filename,
              content: base64Content,
              type: mimeType,
              disposition: "attachment" as const,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to attach file ${filePath}: ${message}`);
          }
        }),
      );

      logger.debug("Processed attachments", {
        count: attachments.length,
        filenames: attachments.map((a) => a.filename),
      });
    }

    // Progress: sending
    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Email", content: `Sending email to ${params.to}...` },
    });

    // Build email parameters with defaults from environment variables
    const emailParams: EmailParams = {
      to: params.to,
      subject: params.subject,
      content: params.content,
      from: params.from || env.SENDGRID_FROM_EMAIL || "noreply@tempestdx.com",
      from_name: params.from_name || env.SENDGRID_FROM_NAME,
      template_id: params.template_id || undefined,
      template_data: params.template_data || undefined,
      attachments,
    };

    const sandboxMode = env.SENDGRID_SANDBOX_MODE === "true";

    logger.debug("Sending email via SendGrid", {
      to: emailParams.to,
      from: emailParams.from,
      sandboxMode,
    });

    // Send email via SendGrid
    const result = await sendEmail(sendGridApiKey, emailParams, { sandboxMode });

    logger.info("Email sent successfully", { to: emailParams.to, message_id: result.message_id });

    return {
      response: `Email sent successfully to ${params.to}`,
      message_id: result.message_id,
      retry_count: result.retry_count,
    };
  },
});
