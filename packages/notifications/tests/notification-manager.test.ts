/**
 * Tests for NotificationManager
 */

import { assertEquals, assertRejects } from "@std/assert";
import { NotificationManager } from "../src/notification-manager.ts";
import { BaseNotificationProvider } from "../src/providers/base-provider.ts";
import { ProviderDisabledError, ProviderNotFoundError } from "../src/types.ts";
import type { EmailParams, MessageParams, NotificationResult } from "@atlas/config";

// Mock provider for testing
class MockProvider extends BaseNotificationProvider {
  public sendEmailCalled = false;
  public sendMessageCalled = false;
  public validateConfigCalled = false;
  public testConnectionCalled = false;

  public shouldFailSendEmail = false;
  public shouldFailSendMessage = false;
  public shouldFailValidation = false;
  public shouldFailConnection = false;

  constructor(name: string, enabled: boolean = true) {
    super(name, "mock", { enabled });
  }

  sendEmail(params: EmailParams): Promise<NotificationResult> {
    this.sendEmailCalled = true;
    this.validateEmailParams(params);

    if (this.shouldFailSendEmail) {
      return Promise.resolve(this.createErrorResponse("Mock send email failure"));
    }

    return Promise.resolve(this.createSuccessResponse("mock-message-id"));
  }

  sendMessage(params: MessageParams): Promise<NotificationResult> {
    this.sendMessageCalled = true;
    this.validateMessageParams(params);

    if (this.shouldFailSendMessage) {
      return Promise.resolve(this.createErrorResponse("Mock send message failure"));
    }

    return Promise.resolve(this.createSuccessResponse("mock-message-id"));
  }

  validateConfig(): Promise<boolean> {
    this.validateConfigCalled = true;

    if (this.shouldFailValidation) {
      return Promise.reject(new Error("Mock validation failure"));
    }

    return Promise.resolve(true);
  }

  testConnection(): Promise<boolean> {
    this.testConnectionCalled = true;

    if (this.shouldFailConnection) {
      return Promise.reject(new Error("Mock connection failure"));
    }

    return Promise.resolve(true);
  }
}

Deno.test("NotificationManager - constructor", () => {
  const mockProvider = new MockProvider("test-provider");
  const manager = new NotificationManager({
    providers: { "test-provider": mockProvider },
    defaultProvider: "test-provider",
  });

  assertEquals(manager.getProviders(), ["test-provider"]);
  assertEquals(manager.hasProvider("test-provider"), true);
  assertEquals(manager.hasProvider("non-existent"), false);
});

Deno.test("NotificationManager - sendEmail success", async () => {
  const mockProvider = new MockProvider("test-provider");
  const manager = new NotificationManager({
    providers: { "test-provider": mockProvider },
    defaultProvider: "test-provider",
    retryConfig: { attempts: 0, delay: 0, backoff: 1 }, // No retries in tests
    timeout: 0, // No timeout in tests
  });

  const emailParams: EmailParams = {
    to: "test@example.com",
    subject: "Test Subject",
    content: "Test content",
  };

  const result = await manager.sendEmail(emailParams);

  assertEquals(result.success, true);
  assertEquals(result.message_id, "mock-message-id");
  assertEquals(mockProvider.sendEmailCalled, true);
});

Deno.test("NotificationManager - sendEmail with specific provider", async () => {
  const mockProvider1 = new MockProvider("provider1");
  const mockProvider2 = new MockProvider("provider2");
  const manager = new NotificationManager({
    providers: {
      "provider1": mockProvider1,
      "provider2": mockProvider2,
    },
    defaultProvider: "provider1",
    retryConfig: { attempts: 0, delay: 0, backoff: 1 }, // No retries in tests
    timeout: 0, // No timeout in tests
  });

  const emailParams: EmailParams = {
    to: "test@example.com",
    subject: "Test Subject",
    content: "Test content",
  };

  const result = await manager.sendEmail(emailParams, "provider2");

  assertEquals(result.success, true);
  assertEquals(mockProvider1.sendEmailCalled, false);
  assertEquals(mockProvider2.sendEmailCalled, true);
});

Deno.test("NotificationManager - sendMessage success", async () => {
  const mockProvider = new MockProvider("test-provider");
  const manager = new NotificationManager({
    providers: { "test-provider": mockProvider },
    defaultProvider: "test-provider",
    retryConfig: { attempts: 0, delay: 0, backoff: 1 }, // No retries in tests
    timeout: 0, // No timeout in tests
  });

  const messageParams: MessageParams = {
    content: "Test message",
    channel: "#test-channel",
  };

  const result = await manager.sendMessage(messageParams);

  assertEquals(result.success, true);
  assertEquals(result.message_id, "mock-message-id");
  assertEquals(mockProvider.sendMessageCalled, true);
});

Deno.test("NotificationManager - provider not found", async () => {
  const manager = new NotificationManager({
    providers: {},
  });

  const emailParams: EmailParams = {
    to: "test@example.com",
    subject: "Test Subject",
    content: "Test content",
  };

  await assertRejects(
    () => manager.sendEmail(emailParams, "non-existent"),
    ProviderNotFoundError,
    "Provider not found: non-existent",
  );
});

Deno.test("NotificationManager - provider disabled", async () => {
  const mockProvider = new MockProvider("test-provider", false); // disabled
  const manager = new NotificationManager({
    providers: { "test-provider": mockProvider },
  });

  const emailParams: EmailParams = {
    to: "test@example.com",
    subject: "Test Subject",
    content: "Test content",
  };

  await assertRejects(
    () => manager.sendEmail(emailParams, "test-provider"),
    ProviderDisabledError,
    "Provider disabled: test-provider",
  );
});

Deno.test("NotificationManager - no default provider", async () => {
  const manager = new NotificationManager({
    providers: {},
  });

  const emailParams: EmailParams = {
    to: "test@example.com",
    subject: "Test Subject",
    content: "Test content",
  };

  await assertRejects(
    () => manager.sendEmail(emailParams),
    Error,
    "No provider specified and no default provider configured",
  );
});

Deno.test("NotificationManager - getProviderStatus", async () => {
  const mockProvider = new MockProvider("test-provider");
  const manager = new NotificationManager({
    providers: { "test-provider": mockProvider },
  });

  const status = await manager.getProviderStatus("test-provider");

  assertEquals(status.name, "test-provider");
  assertEquals(status.type, "mock");
  assertEquals(status.enabled, true);
  assertEquals(status.healthy, true);
  assertEquals(mockProvider.testConnectionCalled, true);
});

Deno.test("NotificationManager - getProviderStatus unhealthy", async () => {
  const mockProvider = new MockProvider("test-provider");
  mockProvider.shouldFailConnection = true;
  const manager = new NotificationManager({
    providers: { "test-provider": mockProvider },
  });

  const status = await manager.getProviderStatus("test-provider");

  assertEquals(status.name, "test-provider");
  assertEquals(status.type, "mock");
  assertEquals(status.enabled, true);
  assertEquals(status.healthy, false);
  assertEquals(typeof status.error, "string");
});

Deno.test("NotificationManager - getAllProviderStatuses", async () => {
  const mockProvider1 = new MockProvider("provider1");
  const mockProvider2 = new MockProvider("provider2");
  mockProvider2.shouldFailConnection = true;

  const manager = new NotificationManager({
    providers: {
      "provider1": mockProvider1,
      "provider2": mockProvider2,
    },
  });

  const statuses = await manager.getAllProviderStatuses();

  assertEquals(statuses.length, 2);
  assertEquals(statuses[0].healthy, true);
  assertEquals(statuses[1].healthy, false);
});

Deno.test("NotificationManager - getEvents", async () => {
  const mockProvider = new MockProvider("test-provider");
  const manager = new NotificationManager({
    providers: { "test-provider": mockProvider },
    defaultProvider: "test-provider",
    retryConfig: { attempts: 0, delay: 0, backoff: 1 }, // No retries in tests
    timeout: 0, // No timeout in tests
  });

  // Send a notification to generate an event
  const emailParams: EmailParams = {
    to: "test@example.com",
    subject: "Test Subject",
    content: "Test content",
  };

  await manager.sendEmail(emailParams);

  const events = manager.getEvents();
  assertEquals(events.length, 1);
  assertEquals(events[0].type, "email");
  assertEquals(events[0].provider, "test-provider");
  assertEquals(events[0].status, "success");
});
