/**
 * SendGrid notification provider
 */

import type {
  EmailParams,
  MessageParams,
  NotificationResult,
  SendGridProvider as SendGridConfig,
} from "@atlas/config";
import { logger } from "@atlas/logger";
import sgMail from "@sendgrid/mail";
import { z } from "zod";
import { getAtlasVersion } from "../../../../src/utils/version.ts";
import { NotificationSendError, ProviderConfigError } from "../types.ts";
import { BaseNotificationProvider, type BaseProviderConfig } from "./base-provider.ts";

// JWT payload schema for Atlas keys
const AtlasJWTPayloadSchema = z.object({
  email: z.string().email().optional(),
  iss: z.literal("tempest-atlas").optional(),
  sub: z.string(),
  exp: z.number(),
  iat: z.number(),
});

/**
 * SendGrid-specific configuration
 */
interface SendGridProviderConfig extends BaseProviderConfig {
  /**
   * SendGrid API key environment variable name
   */
  apiKeyEnv: string;

  /**
   * Default from email address
   */
  fromEmail: string;

  /**
   * Default from name
   */
  fromName?: string;

  /**
   * Default template ID
   */
  templateId?: string;

  /**
   * Enable sandbox mode for testing
   */
  sandboxMode?: boolean;
}

/**
 * SendGrid notification provider implementation
 */
export class SendGridProvider extends BaseNotificationProvider {
  private readonly apiKey: string;
  private readonly fromEmail: string;
  private readonly fromName?: string;
  private readonly templateId?: string;
  private readonly sandboxMode: boolean;

  constructor(name: string, config: SendGridProviderConfig) {
    super(name, "sendgrid", config);

    // Get API key from environment
    this.apiKey = this.getEnvVar(config.apiKeyEnv);
    this.fromEmail = config.fromEmail;
    this.fromName = config.fromName;
    this.templateId = config.templateId;
    this.sandboxMode = config.sandboxMode ?? false;

    // Configure SendGrid
    sgMail.setApiKey(this.apiKey);
  }

  /**
   * Create SendGrid provider from Atlas configuration
   */
  static fromConfig(name: string, config: SendGridConfig): SendGridProvider {
    return new SendGridProvider(name, {
      enabled: config.enabled,
      description: config.description,
      apiKeyEnv: config.config.api_key_env,
      fromEmail: config.config.from_email,
      fromName: config.config.from_name,
      templateId: config.config.template_id,
      sandboxMode: config.config.sandbox_mode,
      timeout: config.config.timeout
        ? SendGridProvider.parseDuration(config.config.timeout)
        : undefined,
    });
  }

  /**
   * Send an email notification
   */
  async sendEmail(params: EmailParams): Promise<NotificationResult> {
    try {
      logger.debug("SendGrid sendEmail called with params", {
        to: params.to,
        subject: params.subject,
        from: params.from,
        hasContent: !!params.content,
        hasAttachments: !!params.attachments?.length,
        hasTemplateId: !!params.template_id,
        hasTemplateData: !!params.template_data,
      });

      this.validateEmailParams(params);
      logger.debug("SendGrid email params validated successfully");

      const message = this.buildEmailMessage(params);
      logger.debug("Built SendGrid message", {
        to: message.to,
        from: message.from,
        subject: message.subject,
        hasHtml: !!message.html,
        hasText: !!message.text,
        hasTemplateId: !!message.templateId,
        hasAttachments: !!message.attachments?.length,
        sandboxMode: this.sandboxMode,
        ipPoolName: message.ipPoolName,
      });

      logger.debug("Sending email via SendGrid API");
      const response = await sgMail.send(message);
      logger.info("SendGrid API response", {
        statusCode: response[0]?.statusCode,
        messageId: response[0]?.headers?.["x-message-id"],
        body: response[0]?.body,
      });

      return this.createSuccessResponse(response[0]?.headers?.["x-message-id"], {
        statusCode: response[0]?.statusCode,
        body: response[0]?.body,
      });
    } catch (error) {
      logger.error("SendGrid sendEmail error", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        // @ts-expect-error - SendGrid error object structure
        statusCode: error?.code || error?.statusCode,
        // @ts-expect-error - SendGrid error object structure
        body: error?.response?.body,
        // @ts-expect-error - SendGrid error object structure
        headers: error?.response?.headers,
      });

      const notificationError = this.handleError(error, "sendEmail");
      return this.createErrorResponse(notificationError.message, 0, {
        code: notificationError.code,
        retryable: notificationError.retryable,
      });
    }
  }

  /**
   * Send a generic message notification
   * For SendGrid, this sends a simple email
   */
  async sendMessage(params: MessageParams): Promise<NotificationResult> {
    try {
      this.validateMessageParams(params);

      // Convert message to email format
      const emailParams: EmailParams = {
        to: params.channel || this.fromEmail, // Use channel as recipient or fall back to from email
        subject: "Atlas Notification",
        content: params.content,
      };

      return await this.sendEmail(emailParams);
    } catch (error) {
      const notificationError = this.handleError(error, "sendMessage");
      return this.createErrorResponse(notificationError.message, 0, {
        code: notificationError.code,
        retryable: notificationError.retryable,
      });
    }
  }

  /**
   * Validate the provider configuration
   */
  async validateConfig(): Promise<boolean> {
    try {
      // Check if API key is set
      if (!this.apiKey) {
        throw new ProviderConfigError(this.name, "SendGrid API key is not set");
      }

      // Check if from email is valid
      if (!this.fromEmail) {
        throw new ProviderConfigError(this.name, "From email is not set");
      }

      // Test API key by making a simple request
      await this.testConnection();

      return true;
    } catch (error) {
      throw this.handleError(error, "validateConfig");
    }
  }

  /**
   * Test the provider connection
   */
  async testConnection(): Promise<boolean> {
    try {
      // Use SendGrid API to check authentication
      // This sends a test email to the from address in sandbox mode
      const testMessage = {
        to: this.fromEmail,
        from: this.fromEmail,
        subject: "Atlas SendGrid Connection Test",
        text: "This is a test message to verify SendGrid connection.",
        mailSettings: {
          sandboxMode: {
            enable: true, // Always use sandbox mode for connection tests
          },
        },
        ipPoolName: "tempest-atlas", // Always use 'tempest-atlas' IP pool
      };

      await sgMail.send(testMessage);
      return true;
    } catch (error) {
      if (error instanceof Error) {
        // Check for authentication errors
        if (error.message.includes("401") || error.message.includes("Unauthorized")) {
          throw new ProviderConfigError(this.name, "Invalid SendGrid API key");
        }
        // Check for other API errors
        if (error.message.includes("403") || error.message.includes("Forbidden")) {
          throw new ProviderConfigError(
            this.name,
            "SendGrid API key does not have sufficient permissions",
          );
        }
      }
      throw this.handleError(error, "testConnection");
    }
  }

  /**
   * Build SendGrid email message from parameters
   */
  public buildEmailMessage(params: EmailParams): sgMail.MailDataRequired {
    // @ts-expect-error the message is built piecemeal below.
    const message: sgMail.MailDataRequired = {
      to: params.to,
      from: { email: params.from || this.fromEmail, name: params.from_name || this.fromName },
      subject: params.subject,
    };

    // Add content
    if (params.content.includes("<html>") || params.content.includes("<body>")) {
      message.html = params.content;
    } else {
      message.text = params.content;
    }

    // Add template support
    if (params.template_id || this.templateId) {
      message.templateId = params.template_id || this.templateId;
      if (params.template_data) {
        message.dynamicTemplateData = params.template_data;
      }
    }

    // Add attachments
    if (params.attachments && params.attachments.length > 0) {
      message.attachments = params.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        type: attachment.type,
        disposition: attachment.disposition,
      }));
    }

    // Add sandbox mode if enabled
    if (this.sandboxMode) {
      message.mailSettings = { sandboxMode: { enable: true } };
    }

    // Always use 'tempest-atlas' IP pool
    message.ipPoolName = "tempest-atlas";

    // Add custom Atlas tracking headers
    message.headers = this.buildCustomHeaders();

    return message;
  }

  /**
   * Build custom headers for Atlas tracking
   */
  public buildCustomHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};

    // Add Atlas version
    headers["X-Atlas-Version"] = getAtlasVersion();

    // Add hostname (always lowercase)
    try {
      headers["X-Atlas-Hostname"] = Deno.hostname().toLowerCase();
    } catch {
      headers["X-Atlas-Hostname"] = "unknown";
    }

    // Add user from Atlas key if available
    const atlasKey = Deno.env.get("ATLAS_KEY");
    if (atlasKey) {
      const userEmail = this.extractUserFromJWT(atlasKey);
      if (userEmail) {
        headers["X-Atlas-User"] = userEmail;
      }
    }

    return headers;
  }

  /**
   * Extract user email from JWT token using proper validation
   */
  public extractUserFromJWT(token: string): string | null {
    try {
      // JWT consists of three base64url-encoded parts separated by dots
      const parts = token.split(".");
      if (parts.length !== 3) {
        return null;
      }

      // Decode the payload (second part)
      const payloadString = parts[1];
      if (!payloadString) {
        return null;
      }

      // Decode base64url (handle URL-safe base64)
      const payload = JSON.parse(atob(payloadString.replace(/-/g, "+").replace(/_/g, "/")));

      // Validate with Zod schema
      const validatedPayload = AtlasJWTPayloadSchema.safeParse(payload);

      if (!validatedPayload.success) {
        return null;
      }

      // Return email if present and valid
      return validatedPayload.data.email || null;
    } catch {
      // Silently fail if JWT parsing fails - headers are optional enhancements
      return null;
    }
  }

  /**
   * Override error handling for SendGrid-specific errors
   */
  protected override handleError(error: unknown, operation: string): NotificationSendError {
    if (error instanceof Error) {
      // Handle SendGrid-specific errors
      if (error.message.includes("401")) {
        return new NotificationSendError(this.name, "Invalid SendGrid API key", false, error);
      }
      if (error.message.includes("403")) {
        return new NotificationSendError(
          this.name,
          "Insufficient permissions for SendGrid API",
          false,
          error,
        );
      }
      if (error.message.includes("429")) {
        return new NotificationSendError(this.name, "Rate limit exceeded", true, error);
      }
      if (
        error.message.includes("500") ||
        error.message.includes("502") ||
        error.message.includes("503")
      ) {
        return new NotificationSendError(this.name, "SendGrid server error", true, error);
      }
    }

    // Fall back to base error handling
    const baseError = super.handleError(error, operation);
    return new NotificationSendError(
      this.name,
      baseError.message,
      baseError.retryable,
      baseError.originalError,
    );
  }

  /**
   * Parse duration string to milliseconds
   */
  private static parseDuration(duration: string): number {
    const match = duration.match(/^(\d+)([smh])$/);
    const rawValue = match?.at(1);
    const rawUnit = match?.at(2);
    if (!rawValue || !rawUnit) {
      throw new Error(`Invalid duration format: ${duration}`);
    }

    const value = parseInt(rawValue, 10);
    const unit = rawUnit;

    switch (unit) {
      case "s":
        return value * 1000;
      case "m":
        return value * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      default:
        throw new Error(`Invalid duration unit: ${unit}`);
    }
  }
}
