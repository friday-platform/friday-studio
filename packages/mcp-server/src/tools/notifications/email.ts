/**
 * Email notification tool for Atlas MCP server
 */

import { type EmailParams, NotificationManager } from "@atlas/notifications";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

/**
 * Register the atlas_notify_email tool
 */
export function registerEmailNotificationTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_notify_email",
    {
      description: `Send email notifications via SendGrid.

Key features:
- Template-based emails with dynamic content
- Attachment support
- Automatic retry with exponential backoff
- Comprehensive error handling

Configuration:
Email notifications use environment variables for configuration:

Optional environment variables:
- SENDGRID_FROM_EMAIL: Default sender email address (defaults to noreply@tempestdx.com)
- SENDGRID_FROM_NAME: Default sender name

Common use cases:
- Alert notifications for system events
- Status updates for job completions
- Error notifications for failed operations
- Scheduled reports and summaries
`,
      inputSchema: {
        to: z.string().describe("Recipient email address"),
        subject: z.string().describe("Email subject line"),
        content: z.string().describe("Email content (HTML or plain text)"),
        from: z
          .string()
          .optional()
          .describe(
            "Override sender email (uses SENDGRID_FROM_EMAIL env var, defaults to noreply@tempestdx.com)",
          ),
        from_name: z
          .string()
          .optional()
          .describe("Override sender name (uses SENDGRID_FROM_NAME env var by default)"),
        template_id: z.string().optional().describe("SendGrid template ID for dynamic templates"),
        template_data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Template variables for dynamic templates"),
        attachments: z
          .array(
            z.object({
              filename: z.string().describe("Attachment filename"),
              content: z.string().describe("Base64 encoded attachment content"),
              type: z.string().describe("MIME type"),
              disposition: z
                .enum(["attachment", "inline"])
                .optional()
                .describe("Attachment disposition: 'attachment' or 'inline'"),
            }),
          )
          .optional()
          .describe("Email attachments"),
      },
    },
    async ({ to, subject, content, from, from_name, template_id, template_data, attachments }) => {
      try {
        // Validate email address
        if (!to || typeof to !== "string") {
          return createErrorResponse("Invalid 'to' parameter: must be a valid email address");
        }

        // Check for required SendGrid environment variables
        const sendGridApiKey = Deno.env.get("SENDGRID_API_KEY");
        if (!sendGridApiKey) {
          return createErrorResponse(
            "SENDGRID_API_KEY environment variable is required. Please set it in your .env file.",
          );
        }

        const defaultFromEmail = Deno.env.get("SENDGRID_FROM_EMAIL") || "noreply@tempestdx.com";
        const defaultFromName = Deno.env.get("SENDGRID_FROM_NAME");
        const sandboxMode = Deno.env.get("SENDGRID_SANDBOX_MODE");

        ctx.logger.info("🔍 SendGrid environment configuration:", {
          hasApiKey: !!sendGridApiKey,
          apiKeyPrefix: sendGridApiKey ? `${sendGridApiKey.substring(0, 6)}...` : "none",
          defaultFromEmail,
          defaultFromName,
          sandboxMode,
        });

        // Build email parameters with environment variable defaults
        const emailParams: EmailParams = {
          to,
          subject,
          content,
          from: from || defaultFromEmail,
          from_name: from_name || defaultFromName,
          template_id,
          template_data,
          attachments: attachments?.map((att) => ({
            filename: att.filename,
            content: att.content,
            type: att.type,
            disposition: att.disposition || "attachment",
          })),
        };

        // Validate that we have a from email
        if (!emailParams.from) {
          return createErrorResponse(
            "Sender email is required. Please provide 'from' parameter or set SENDGRID_FROM_EMAIL environment variable.",
          );
        }

        // Create a simple SendGrid provider configuration
        const sendGridConfig = {
          providers: {
            sendgrid: {
              provider: "sendgrid" as const,
              enabled: true,
              config: {
                api_key_env: "SENDGRID_API_KEY",
                from_email: emailParams.from,
                from_name: emailParams.from_name,
                template_id: emailParams.template_id,
                timeout: "30s",
                sandbox_mode: Deno.env.get("SENDGRID_SANDBOX_MODE") === "true",
              },
            },
          },
          defaults: {
            enabled: true,
            provider: "sendgrid",
            retry_attempts: 3,
            retry_delay: "5s",
            retry_backoff: 2,
            timeout: "30s",
          },
        };

        // Create notification manager
        const notificationManager = await NotificationManager.fromConfig(sendGridConfig);

        const result = await notificationManager.sendEmail(emailParams, "sendgrid");

        if (result.success) {
          ctx.logger.info("Email notification sent successfully", {
            to: emailParams.to,
            message_id: result.message_id,
            provider: "sendgrid",
          });

          return createSuccessResponse({
            message: "Email notification sent successfully",
            message_id: result.message_id,
            provider: "sendgrid",
            retry_count: result.retry_count || 0,
            metadata: result.metadata,
          });
        } else {
          ctx.logger.error("Failed to send email notification", {
            to: emailParams.to,
            provider: "sendgrid",
            error: result.error,
            retry_count: result.retry_count,
          });

          return createErrorResponse(`Failed to send email notification: ${result.error}`, {
            retry_count: result.retry_count,
            metadata: result.metadata,
          });
        }
      } catch (error) {
        ctx.logger.error("Error in email notification tool", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        return createErrorResponse(
          `Email notification failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
