/**
 * Tests for BaseNotificationProvider
 */

import type { EmailParams, MessageParams, NotificationResult } from "@atlas/config";
import { assertEquals, assertRejects } from "@std/assert";
import { BaseNotificationProvider } from "../src/providers/base-provider.ts";
import { ProviderConfigError } from "../src/types.ts";

// Concrete implementation for testing
class TestProvider extends BaseNotificationProvider {
  public validateConfigCalled = false;
  public testConnectionCalled = false;

  constructor(name: string, enabled: boolean = true) {
    super(name, "test", { enabled });
  }

  async sendEmail(params: EmailParams): Promise<NotificationResult> {
    this.validateEmailParams(params);
    return this.createSuccessResponse("test-message-id");
  }

  async sendMessage(params: MessageParams): Promise<NotificationResult> {
    this.validateMessageParams(params);
    return this.createSuccessResponse("test-message-id");
  }

  validateConfig(): Promise<boolean> {
    this.validateConfigCalled = true;
    return Promise.resolve(true);
  }

  testConnection(): Promise<boolean> {
    this.testConnectionCalled = true;
    return Promise.resolve(true);
  }
}

Deno.test("BaseNotificationProvider - constructor", () => {
  const provider = new TestProvider("test-provider");

  assertEquals(provider.name, "test-provider");
  assertEquals(provider.type, "test");
  assertEquals(provider.enabled, true);
});

Deno.test("BaseNotificationProvider - constructor disabled", () => {
  const provider = new TestProvider("test-provider", false);

  assertEquals(provider.name, "test-provider");
  assertEquals(provider.type, "test");
  assertEquals(provider.enabled, false);
});

Deno.test("BaseNotificationProvider - validateEmailParams valid", () => {
  const provider = new TestProvider("test-provider");

  const params: EmailParams = {
    to: "test@example.com",
    subject: "Test Subject",
    content: "Test content",
  };

  // Should not throw
  provider.sendEmail(params);
});

Deno.test("BaseNotificationProvider - validateEmailParams missing to", async () => {
  const provider = new TestProvider("test-provider");

  const params = { subject: "Test Subject", content: "Test content" } as EmailParams;

  await assertRejects(
    () => provider.sendEmail(params),
    ProviderConfigError,
    "Missing required parameter: to",
  );
});

Deno.test("BaseNotificationProvider - validateEmailParams missing subject", async () => {
  const provider = new TestProvider("test-provider");

  const params = { to: "test@example.com", content: "Test content" } as EmailParams;

  await assertRejects(
    () => provider.sendEmail(params),
    ProviderConfigError,
    "Missing required parameter: subject",
  );
});

Deno.test("BaseNotificationProvider - validateEmailParams missing content", async () => {
  const provider = new TestProvider("test-provider");

  const params = { to: "test@example.com", subject: "Test Subject" } as EmailParams;

  await assertRejects(
    () => provider.sendEmail(params),
    ProviderConfigError,
    "Missing required parameter: content",
  );
});

Deno.test("BaseNotificationProvider - validateEmailParams invalid email", async () => {
  const provider = new TestProvider("test-provider");

  const params: EmailParams = {
    to: "invalid-email",
    subject: "Test Subject",
    content: "Test content",
  };

  await assertRejects(
    () => provider.sendEmail(params),
    ProviderConfigError,
    "Invalid email address: invalid-email",
  );
});

Deno.test("BaseNotificationProvider - validateEmailParams invalid from email", async () => {
  const provider = new TestProvider("test-provider");

  const params: EmailParams = {
    to: "test@example.com",
    from: "invalid-email",
    subject: "Test Subject",
    content: "Test content",
  };

  await assertRejects(
    () => provider.sendEmail(params),
    ProviderConfigError,
    "Invalid from email address: invalid-email",
  );
});

Deno.test("BaseNotificationProvider - validateEmailParams multiple recipients", async () => {
  const provider = new TestProvider("test-provider");

  const params: EmailParams = {
    to: ["test1@example.com", "test2@example.com"],
    subject: "Test Subject",
    content: "Test content",
  };

  // Should not throw
  const result = await provider.sendEmail(params);
  assertEquals(result.success, true);
});

Deno.test("BaseNotificationProvider - validateEmailParams invalid recipient in array", async () => {
  const provider = new TestProvider("test-provider");

  const params: EmailParams = {
    to: ["test1@example.com", "invalid-email"],
    subject: "Test Subject",
    content: "Test content",
  };

  await assertRejects(
    () => provider.sendEmail(params),
    ProviderConfigError,
    "Invalid email address: invalid-email",
  );
});

Deno.test("BaseNotificationProvider - validateMessageParams valid", async () => {
  const provider = new TestProvider("test-provider");

  const params: MessageParams = { content: "Test message", channel: "#test-channel" };

  // Should not throw
  const result = await provider.sendMessage(params);
  assertEquals(result.success, true);
});

Deno.test("BaseNotificationProvider - validateMessageParams missing content", async () => {
  const provider = new TestProvider("test-provider");

  const params = { channel: "#test-channel" } as MessageParams;

  await assertRejects(
    () => provider.sendMessage(params),
    ProviderConfigError,
    "Missing required parameter: content",
  );
});

Deno.test("BaseNotificationProvider - createSuccessResponse", async () => {
  const provider = new TestProvider("test-provider");

  const params: EmailParams = {
    to: "test@example.com",
    subject: "Test Subject",
    content: "Test content",
  };

  const result = await provider.sendEmail(params);

  assertEquals(result.success, true);
  assertEquals(result.message_id, "test-message-id");
  assertEquals(result.error, undefined);
});

Deno.test("BaseNotificationProvider - getEnvVar success", () => {
  // Set test environment variable
  Deno.env.set("TEST_ENV_VAR", "test-value");

  const provider = new TestProvider("test-provider");

  // Access protected method through type assertion
  const value = (provider as TestProvider & { getEnvVar: (name: string) => string }).getEnvVar(
    "TEST_ENV_VAR",
  );
  assertEquals(value, "test-value");

  // Clean up
  Deno.env.delete("TEST_ENV_VAR");
});

Deno.test("BaseNotificationProvider - getEnvVar missing", () => {
  const provider = new TestProvider("test-provider");

  // Should throw for missing environment variable
  try {
    (provider as TestProvider & { getEnvVar: (name: string) => string }).getEnvVar(
      "NON_EXISTENT_VAR",
    );
    throw new Error("Should have thrown");
  } catch (error) {
    assertEquals(error instanceof ProviderConfigError, true);
    assertEquals(
      error.message,
      "Provider configuration error: Environment variable NON_EXISTENT_VAR is not set",
    );
  }
});

Deno.test("BaseNotificationProvider - getTimeout default", () => {
  const provider = new TestProvider("test-provider");

  const timeout = (provider as TestProvider & { getTimeout: () => number }).getTimeout();
  assertEquals(timeout, 30000); // 30 seconds default
});

Deno.test("BaseNotificationProvider - getTimeout custom", () => {
  const provider = new TestProvider("test-provider");
  (
    provider as TestProvider & { config: { timeout: number }; getTimeout: () => number }
  ).config.timeout = 60000;

  const timeout = (provider as TestProvider & { getTimeout: () => number }).getTimeout();
  assertEquals(timeout, 60000);
});
