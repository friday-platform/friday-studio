import { homedir } from "node:os";
import { env } from "node:process";
import { createAgent } from "@atlas/agent-sdk";
import type { EmailParams } from "@atlas/config";
import { anthropic } from "@atlas/core";
import { getTodaysDate } from "@atlas/utils";
import { encodeBase64 } from "@std/encoding/base64";
import { contentType } from "@std/media-types";
import { resolve } from "@std/path";
import { generateObject } from "ai";
import { z } from "zod";
import { sendEmail } from "./sendgrid.ts";
import template from "./template.html" with { type: "text" };

/**
 * Email Agent
 *
 * Generates and sends email notifications via SendGrid.
 * Takes natural language prompts with data/context and composes appropriate email content.
 */
type Result = {
  response: string;
  message_id?: string;
  email?: { to: string | string[]; subject: string; content: string; from: string | undefined };
};

export const emailAgent = createAgent<string, Result>({
  id: "email",
  displayName: "Email",
  version: "1.0.0",
  description:
    "Compose and send email notifications via SendGrid. Generates email content from provided data/context, with template support, file attachments, and automatic retry with exponential backoff",
  expertise: {
    domains: ["email", "notifications", "sendgrid"],
    examples: [
      "Send email to john@example.com with subject 'Test' saying hello",
      "Email sarah@company.com a meeting reminder for 2pm today",
      "Send deployment completion notification to team@startup.io",
      "Create professional pricing report email from this data and send to client@company.com",
      "Compose weekly summary email from these metrics and send to stakeholders@corp.com",
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

    // Progress: composing
    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Email", content: `Composing email...` },
    });

    // Define schema for email composition
    const emailCompositionSchema = z.object({
      to: z.email().describe("Recipient email address"),
      subject: z.string().min(1).describe("Email subject line"),
      content: z.array(
        z.object({
          tag: z
            .enum(["paragraph", "heading", "link"])
            .describe("Preferred tag for part of the content"),
          content: z.string().min(1).describe("Content to be wrapped in the tag"),
        }),
      ),
      from: z.email().nullable().default(null).describe("Sender email address (optional)"),
      from_name: z.string().nullable().default(null).describe("Sender name (optional)"),
      attachment_paths: z
        .array(z.string())
        .nullable()
        .default(null)
        .describe("File paths to attach to the email (optional)"),
    });

    const compositionSystem = `
You are an email composition expert. Your job is to generate professional email content from natural language prompts and data.

Today's date: ${getTodaysDate()}

TASK:
1. Analyze the prompt for data, context, and requirements
2. Generate an appropriate email subject line
3. Compose professional email body content
4. Determine recipient email address
5. Extract any sender details or attachment paths if specified

CONTENT GENERATION GUIDELINES:
- Use HTML formatting for structured content (tables, lists, sections)
- Keep tone professional but friendly
- Include all relevant data points from the context
- Use clear section headers for multi-part content
- Make subject line descriptive and specific
- Format numbers, prices, and data clearly
- Preserve links and URLs from source data

OUTPUT:
- to: Recipient email address (required)
- subject: Descriptive subject line (required)
- content: Well-formatted email body - HTML or plain text (required)
- from: Sender email if specified (optional, default null)
- from_name: Sender name if specified (optional, default null)
- attachment_paths: Array of file paths if specified (optional, default null)
    `;

    const compositionResult = await generateObject({
      model: anthropic("claude-haiku-4-5"),
      prompt,
      abortSignal,
      system: compositionSystem,
      schema: emailCompositionSchema,
      temperature: 0.3,
      maxOutputTokens: 4000,
    });

    const params = compositionResult.object;
    logger.debug("email-communicator composed email", {
      to: params.to,
      subject: params.subject,
      contentLength: params.content.length,
    });

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
                `File exceeds 30MB SendGrid limit: ${filePath} (${(stat.size / 1024 / 1024).toFixed(
                  2,
                )}MB)`,
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
      content: template.replace(
        "{{ content }}",
        params.content
          .map((c) => {
            if (c.tag === "paragraph") {
              return `<p style="font-size: 15px; font-weight: 450; line-height: 155%; margin: 8px 0 12px 0;">${c.content}</p>`;
            } else if (c.tag === "heading") {
              return `<h2 style="font-size: 17px; font-weight: 650;  margin: 16px 0 0 0;">${c.content}</h2>`;
            } else if (c.tag === "link") {
              return `<a style="color: #2A54DF; text-decoration: underline;" href="${c.content}">${c.content}</a>`;
            }
            return c.content;
          })
          .join(""),
      ),
      from: params.from || env.SENDGRID_FROM_EMAIL || "noreply@tempestdx.com",
      from_name: params.from_name || env.SENDGRID_FROM_NAME,
      attachments,
    };

    const sandboxMode = env.SENDGRID_SANDBOX_MODE === "true";

    logger.debug("Sending email via SendGrid", {
      to: emailParams.to,
      from: emailParams.from,
      content: emailParams.content,
      sandboxMode,
    });

    // Send email via SendGrid
    const result = await sendEmail(sendGridApiKey, emailParams, { sandboxMode });
    const message_id = result[0]?.headers?.["x-message-id"];

    logger.info("Email sent successfully", { to: emailParams.to, message_id });

    return {
      response: `Email sent successfully to ${params.to}`,
      message_id,
      email: {
        to: emailParams.to,
        subject: emailParams.subject,
        content: emailParams.content,
        from: emailParams.from,
      },
    };
  },
});
