import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { env } from "node:process";
import { createAgent } from "@atlas/agent-sdk";
import type { EmailParams } from "@atlas/config";
import { getDefaultProviderOpts, registry } from "@atlas/llm";
import { getTodaysDate } from "@atlas/utils";
import { encodeBase64 } from "@std/encoding/base64";
import { contentType } from "@std/media-types";
import { resolve } from "@std/path";
import { streamText, tool } from "ai";
import { z } from "zod";
import { extractUserFromJWT, sendEmail } from "./sendgrid.ts";
import { template } from "./template.ts";

/**
 * Email Agent
 *
 * Generates and sends email notifications via SendGrid.
 * Takes natural language prompts with data/context and composes appropriate email content.
 */
type Result = {
  response: string;
  message_id?: string;
  email?: { to: string | string[]; subject: string; content: string; from: string };
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
      data: { toolName: "Email", content: `Composing email` },
    });

    // Track state for tool-based composition
    const failureState = { failed: false, reason: "" };
    const composeEmailSchema = z.object({
      to: z.string().email().describe("Recipient email address"),
      subject: z.string().min(1).describe("Email subject line"),
      content: z.array(
        z.object({
          tag: z
            .enum(["paragraph", "heading", "link"])
            .describe("Preferred tag for part of the content"),
          content: z.string().min(1).describe("Content to be wrapped in the tag"),
        }),
      ),
      from: z
        .string()
        .email()
        .optional()
        .describe("Sender email address. Omit if not specified in prompt"),
      from_name: z.string().optional().describe("Sender display name. Omit if not specified"),
      attachment_paths: z
        .array(z.string())
        .optional()
        .describe("File paths to attach. Omit if none specified"),
    });
    type ComposedEmail = z.infer<typeof composeEmailSchema>;
    let composedEmail: ComposedEmail | null = null;

    const compositionSystem = `You are an email composition expert. Analyze the prompt and either compose an email or report that you cannot.

DECISION:
- Call composeEmail if the prompt contains ALL data needed to compose a meaningful email
- Call emailFailed if the request requires:
  - Previous emails you don't have access to (e.g., "resend the email", "forward the last message")
  - External data lookups you cannot perform (e.g., "look up stock prices")
  - Information not present in the prompt
  - Content that must be retrieved from somewhere you cannot access

You MUST call exactly one tool. Either composeEmail with the email parameters, or emailFailed with the reason.

CONTENT GUIDELINES (for composeEmail):
- Professional but friendly tone
- Clear section headers for multi-part content
- Descriptive subject line
- Format numbers, prices, and data clearly
- Preserve links and URLs from source data

`;

    const compositionStream = streamText({
      model: registry.languageModel("anthropic:claude-haiku-4-5"),
      messages: [
        {
          role: "system",
          content: compositionSystem,
          providerOptions: getDefaultProviderOpts("anthropic"),
        },
        { role: "system", content: `Today's date: ${getTodaysDate()}` },
        { role: "user", content: prompt },
      ],
      abortSignal,
      tools: {
        composeEmail: tool({
          description: "Compose an email with the given parameters",
          inputSchema: composeEmailSchema,
          execute: (params) => {
            composedEmail = params;
            return { status: "success", reason: null };
          },
        }),
        emailFailed: tool({
          description:
            "Signal that the email cannot be composed due to missing information or unfulfillable request",
          inputSchema: z.object({
            reason: z.string().describe("Why the email cannot be composed"),
          }),
          execute: ({ reason }) => {
            failureState.failed = true;
            failureState.reason = reason;
            return { status: "failed", reason };
          },
        }),
      },
      maxOutputTokens: 4000,
      temperature: 0.3,
      toolChoice: "required",
    });

    // Wait for tool execution to complete (not just text output)
    await compositionStream.toolResults;

    // Log token usage
    const usage = await compositionStream.usage;
    logger.debug("AI SDK streamText completed", { agent: "email", usage });

    // Check if composition failed
    if (failureState.failed) {
      logger.warn("Email composition refused", { reason: failureState.reason });
      throw new Error(`Cannot compose email: ${failureState.reason}`);
    }

    // Check if no tool was called
    if (!composedEmail) {
      logger.warn("Email composition did not complete - no tool called");
      throw new Error("Cannot compose email: The agent did not produce a result");
    }

    // Type assertion needed because TS can't track mutation in tool execute callback
    const params = composedEmail as ComposedEmail;

    // Security validation: Verify recipient email is in prompt
    if (!prompt.toLowerCase().includes(params.to.toLowerCase())) {
      throw new Error(
        `Security: Recipient email "${params.to}" not found in prompt. The agent may be hallucinating email addresses.`,
      );
    }

    // Security validation: Verify sender email (if provided) is in prompt, otherwise use default
    if (params.from && !prompt.toLowerCase().includes(params.from.toLowerCase())) {
      logger.warn("Security: Sender email not in prompt, using default", {
        hallucinated: params.from,
      });
      params.from = undefined; // Fall back to default
    }

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
          content: `Processing ${params.attachment_paths.length} attachment(s)`,
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
            const fileStat = await stat(filePath);

            // Check if it's a file (not directory)
            if (!fileStat.isFile()) {
              throw new Error(`Path is not a file: ${filePath}`);
            }

            // Check file size (SendGrid limit: 30MB total attachments)
            const maxSize = 30 * 1024 * 1024; // 30MB in bytes
            if (fileStat.size > maxSize) {
              throw new Error(
                `File exceeds 30MB SendGrid limit: ${filePath} (${(
                  fileStat.size / 1024 / 1024
                ).toFixed(2)}MB)`,
              );
            }

            const content = await readFile(filePath);
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
      data: { toolName: "Email", content: `Sending email to ${params.to}` },
    });

    // Build email parameters with defaults from environment variables
    const fromEmail = params.from || env.SENDGRID_FROM_EMAIL || "noreply@tempestdx.com";
    const atlasUserEmail = env.ATLAS_KEY ? extractUserFromJWT(env.ATLAS_KEY) : null;
    if (!atlasUserEmail) {
      logger.warn(
        "No user email found in ATLAS_KEY JWT, sender info will not be shown in email footer",
      );
    }
    const senderInfo = atlasUserEmail
      ? `<p style="font-size: 12px;">Sent by ${atlasUserEmail}</p>`
      : "";

    const emailParams: EmailParams = {
      to: params.to,
      subject: params.subject,
      content: template
        .replace(
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
        )
        .replace("{{ sender_info }}", senderInfo),
      from: fromEmail,
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
        from: fromEmail,
      },
    };
  },
});
