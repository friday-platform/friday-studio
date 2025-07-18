/**
 * Integration tests for SendGrid provider
 * These tests require a valid SendGrid API key to be set in environment variables
 */

import { assertEquals } from "@std/assert";
import { SendGridProvider } from "../src/providers/sendgrid-provider.ts";
import type { EmailParams } from "@atlas/config";

// Skip integration tests if no API key is provided
const hasApiKey = Deno.env.get("SENDGRID_API_KEY_TEST");

Deno.test({
  name: "SendGrid integration - validateConfig",
  ignore: !hasApiKey,
  async fn() {
    const provider = new SendGridProvider("test-sendgrid", {
      enabled: true,
      apiKeyEnv: "SENDGRID_API_KEY_TEST",
      fromEmail: "test@example.com",
      fromName: "Test Sender",
      sandboxMode: true, // Always use sandbox mode for tests
    });

    const isValid = await provider.validateConfig();
    assertEquals(isValid, true);
  },
});

Deno.test({
  name: "SendGrid integration - testConnection",
  ignore: !hasApiKey,
  async fn() {
    const provider = new SendGridProvider("test-sendgrid", {
      enabled: true,
      apiKeyEnv: "SENDGRID_API_KEY_TEST",
      fromEmail: "test@example.com",
      fromName: "Test Sender",
      sandboxMode: true, // Always use sandbox mode for tests
    });

    const isHealthy = await provider.testConnection();
    assertEquals(isHealthy, true);
  },
});

Deno.test({
  name: "SendGrid integration - sendEmail sandbox",
  ignore: !hasApiKey,
  async fn() {
    const provider = new SendGridProvider("test-sendgrid", {
      enabled: true,
      apiKeyEnv: "SENDGRID_API_KEY_TEST",
      fromEmail: "test@example.com",
      fromName: "Test Sender",
      sandboxMode: true, // Always use sandbox mode for tests
    });

    const emailParams: EmailParams = {
      to: "recipient@example.com",
      subject: "Atlas Notification Test",
      content: "This is a test email from Atlas notifications system.",
    };

    const result = await provider.sendEmail(emailParams);

    assertEquals(result.success, true);
    assertEquals(typeof result.message_id, "string");
  },
});

Deno.test({
  name: "SendGrid integration - sendEmail with template",
  ignore: !hasApiKey,
  async fn() {
    const provider = new SendGridProvider("test-sendgrid", {
      enabled: true,
      apiKeyEnv: "SENDGRID_API_KEY_TEST",
      fromEmail: "test@example.com",
      fromName: "Test Sender",
      sandboxMode: true, // Always use sandbox mode for tests
    });

    const emailParams: EmailParams = {
      to: "recipient@example.com",
      subject: "Atlas Notification Test with Template",
      content: "Fallback content",
      template_id: "d-123456789", // Test template ID
      template_data: {
        name: "Test User",
        message: "This is a test notification",
      },
    };

    const result = await provider.sendEmail(emailParams);

    assertEquals(result.success, true);
    assertEquals(typeof result.message_id, "string");
  },
});

Deno.test({
  name: "SendGrid integration - sendMessage",
  ignore: !hasApiKey,
  async fn() {
    const provider = new SendGridProvider("test-sendgrid", {
      enabled: true,
      apiKeyEnv: "SENDGRID_API_KEY_TEST",
      fromEmail: "test@example.com",
      fromName: "Test Sender",
      sandboxMode: true, // Always use sandbox mode for tests
    });

    const result = await provider.sendMessage({
      content: "This is a test message from Atlas notifications system.",
      channel: "test-channel@example.com",
    });

    assertEquals(result.success, true);
    assertEquals(typeof result.message_id, "string");
  },
});
