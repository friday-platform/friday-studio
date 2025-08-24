/**
 * Tests for SendGrid custom headers implementation
 * Tests verify that Atlas tracking headers are properly added to emails
 */

import type { EmailParams } from "@atlas/config";
import { assertEquals, assertExists } from "@std/assert";
import { getAtlasVersion } from "../../../src/utils/version.ts";
import { SendGridProvider } from "../src/providers/sendgrid-provider.ts";

Deno.test("SendGrid Custom Headers - buildCustomHeaders includes all required headers", async (t) => {
  await t.step("includes X-Atlas-Version header", () => {
    // Set a mock API key for testing
    Deno.env.set("SENDGRID_API_KEY", "SG.test-key");

    try {
      const provider = new SendGridProvider("test", {
        enabled: true,
        apiKeyEnv: "SENDGRID_API_KEY",
        fromEmail: "test@example.com",
        sandboxMode: true,
      });

      // Access private method via type assertion for testing
      const buildCustomHeaders = provider.buildCustomHeaders.bind(provider);
      const headers = buildCustomHeaders();

      // Verify X-Atlas-Version header exists and matches expected version
      assertExists(headers["X-Atlas-Version"]);
      assertEquals(headers["X-Atlas-Version"], getAtlasVersion());
    } finally {
      Deno.env.delete("SENDGRID_API_KEY");
    }
  });

  await t.step("includes X-Atlas-Hostname header", () => {
    Deno.env.set("SENDGRID_API_KEY", "SG.test-key");

    try {
      const provider = new SendGridProvider("test", {
        enabled: true,
        apiKeyEnv: "SENDGRID_API_KEY",
        fromEmail: "test@example.com",
        sandboxMode: true,
      });

      const buildCustomHeaders = provider.buildCustomHeaders.bind(provider);
      const headers = buildCustomHeaders();

      // Verify X-Atlas-Hostname header exists
      assertExists(headers["X-Atlas-Hostname"]);

      // Should either be the actual hostname or "unknown"
      const hostname = headers["X-Atlas-Hostname"];
      assertEquals(typeof hostname, "string");
      assertEquals(hostname.length > 0, true);

      // Try to get the actual hostname for comparison (should be lowercase)
      try {
        const expectedHostname = Deno.hostname().toLowerCase();
        if (hostname !== "unknown") {
          assertEquals(hostname, expectedHostname);
        }
      } catch {
        // If hostname() fails, the header should be "unknown"
        assertEquals(hostname, "unknown");
      }
    } finally {
      Deno.env.delete("SENDGRID_API_KEY");
    }
  });

  await t.step("includes X-Atlas-User when ATLAS_KEY is present", () => {
    // Create a mock JWT token with email
    const mockPayload = {
      email: "test.user@tempest.team",
      iss: "tempest-atlas",
      sub: "user-123",
      exp: Math.floor(Date.now() / 1000) + 3600, // Valid for 1 hour
      iat: Math.floor(Date.now() / 1000),
    };
    const mockJWT = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${btoa(
      JSON.stringify(mockPayload),
    )}.mock-signature`;

    const originalKey = Deno.env.get("ATLAS_KEY");
    Deno.env.set("ATLAS_KEY", mockJWT);
    Deno.env.set("SENDGRID_API_KEY", "SG.test-key");

    try {
      const provider = new SendGridProvider("test", {
        enabled: true,
        apiKeyEnv: "SENDGRID_API_KEY",
        fromEmail: "test@example.com",
        sandboxMode: true,
      });

      const buildCustomHeaders = provider.buildCustomHeaders.bind(provider);
      const headers = buildCustomHeaders();

      // Verify X-Atlas-User header is included with the email from JWT
      assertEquals(headers["X-Atlas-User"], "test.user@tempest.team");
    } finally {
      if (originalKey) {
        Deno.env.set("ATLAS_KEY", originalKey);
      } else {
        Deno.env.delete("ATLAS_KEY");
      }
      Deno.env.delete("SENDGRID_API_KEY");
    }
  });

  await t.step("excludes X-Atlas-User when ATLAS_KEY is missing", () => {
    const originalKey = Deno.env.get("ATLAS_KEY");
    Deno.env.delete("ATLAS_KEY");
    Deno.env.set("SENDGRID_API_KEY", "SG.test-key");

    try {
      const provider = new SendGridProvider("test", {
        enabled: true,
        apiKeyEnv: "SENDGRID_API_KEY",
        fromEmail: "test@example.com",
        sandboxMode: true,
      });

      const buildCustomHeaders = provider.buildCustomHeaders.bind(provider);
      const headers = buildCustomHeaders();

      // Verify X-Atlas-User header is not included when ATLAS_KEY is missing
      assertEquals(headers["X-Atlas-User"], undefined);

      // But other headers should still be present
      assertExists(headers["X-Atlas-Version"]);
      assertExists(headers["X-Atlas-Hostname"]);
    } finally {
      if (originalKey) {
        Deno.env.set("ATLAS_KEY", originalKey);
      }
      Deno.env.delete("SENDGRID_API_KEY");
    }
  });
});

Deno.test("SendGrid Custom Headers - JWT parsing handles edge cases", async (t) => {
  await t.step("handles invalid JWT format gracefully", () => {
    Deno.env.set("SENDGRID_API_KEY", "SG.test-key");

    try {
      const provider = new SendGridProvider("test", {
        enabled: true,
        apiKeyEnv: "SENDGRID_API_KEY",
        fromEmail: "test@example.com",
        sandboxMode: true,
      });

      const extractUserFromJWT = provider.extractUserFromJWT.bind(provider);

      // Test various invalid JWT formats
      assertEquals(extractUserFromJWT("invalid"), null);
      assertEquals(extractUserFromJWT(""), null);
      assertEquals(extractUserFromJWT("part1.part2"), null); // Only 2 parts
      assertEquals(extractUserFromJWT("part1.part2.part3.part4"), null); // Too many parts
      assertEquals(extractUserFromJWT("header.invalidbase64!@#.signature"), null); // Invalid base64
      assertEquals(extractUserFromJWT("header..signature"), null); // Empty payload
    } finally {
      Deno.env.delete("SENDGRID_API_KEY");
    }
  });

  await t.step("handles JWT without email field", () => {
    Deno.env.set("SENDGRID_API_KEY", "SG.test-key");

    try {
      const provider = new SendGridProvider("test", {
        enabled: true,
        apiKeyEnv: "SENDGRID_API_KEY",
        fromEmail: "test@example.com",
        sandboxMode: true,
      });

      const extractUserFromJWT = provider.extractUserFromJWT.bind(provider);

      // JWT with valid structure but no email field
      const payloadNoEmail = {
        iss: "tempest-atlas",
        sub: "user-123",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      };
      const jwtNoEmail = `header.${btoa(JSON.stringify(payloadNoEmail))}.signature`;

      assertEquals(extractUserFromJWT(jwtNoEmail), null);
    } finally {
      Deno.env.delete("SENDGRID_API_KEY");
    }
  });

  await t.step("handles JWT with invalid email format", () => {
    Deno.env.set("SENDGRID_API_KEY", "SG.test-key");

    try {
      const provider = new SendGridProvider("test", {
        enabled: true,
        apiKeyEnv: "SENDGRID_API_KEY",
        fromEmail: "test@example.com",
        sandboxMode: true,
      });

      const extractUserFromJWT = provider.extractUserFromJWT.bind(provider);

      // JWT with invalid email format
      const payloadInvalidEmail = {
        email: "not-an-email",
        iss: "tempest-atlas",
        sub: "user-123",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      };
      const jwtInvalidEmail = `header.${btoa(JSON.stringify(payloadInvalidEmail))}.signature`;

      // Should return null because email validation fails
      assertEquals(extractUserFromJWT(jwtInvalidEmail), null);
    } finally {
      Deno.env.delete("SENDGRID_API_KEY");
    }
  });

  await t.step("handles base64url encoded JWT", () => {
    Deno.env.set("SENDGRID_API_KEY", "SG.test-key");

    try {
      const provider = new SendGridProvider("test", {
        enabled: true,
        apiKeyEnv: "SENDGRID_API_KEY",
        fromEmail: "test@example.com",
        sandboxMode: true,
      });

      const extractUserFromJWT = provider.extractUserFromJWT.bind(provider);

      // Create base64url encoded JWT (with - and _ instead of + and /)
      const payload = {
        email: "user@example.com",
        iss: "tempest-atlas",
        sub: "user-123",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      };

      // Create base64url by replacing + with - and / with _
      const base64url = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_");
      const jwtBase64url = `header.${base64url}.signature`;

      assertEquals(extractUserFromJWT(jwtBase64url), "user@example.com");
    } finally {
      Deno.env.delete("SENDGRID_API_KEY");
    }
  });
});

Deno.test("SendGrid Custom Headers - buildEmailMessage includes headers", async (t) => {
  await t.step("email message includes custom headers", () => {
    Deno.env.set("SENDGRID_API_KEY", "SG.test-key");

    try {
      const provider = new SendGridProvider("test", {
        enabled: true,
        apiKeyEnv: "SENDGRID_API_KEY",
        fromEmail: "test@example.com",
        sandboxMode: true,
      });

      const buildEmailMessage = provider.buildEmailMessage.bind(provider);

      const emailParams: EmailParams = {
        to: "recipient@example.com",
        subject: "Test Email",
        content: "Test content",
      };

      const message = buildEmailMessage(emailParams);

      // Verify headers are included in the message
      assertExists(message.headers);
      assertEquals(typeof message.headers, "object");

      // Verify required headers are present
      assertExists(message.headers["X-Atlas-Version"]);
      assertExists(message.headers["X-Atlas-Hostname"]);
    } finally {
      Deno.env.delete("SENDGRID_API_KEY");
    }
  });

  await t.step("headers are added to emails with templates", () => {
    Deno.env.set("SENDGRID_API_KEY", "SG.test-key");

    try {
      const provider = new SendGridProvider("test", {
        enabled: true,
        apiKeyEnv: "SENDGRID_API_KEY",
        fromEmail: "test@example.com",
        sandboxMode: true,
        templateId: "d-default-template",
      });

      const buildEmailMessage = provider.buildEmailMessage.bind(provider);

      const emailParams: EmailParams = {
        to: "recipient@example.com",
        subject: "Test Email",
        content: "Test content",
        template_id: "d-specific-template",
        template_data: { name: "Test User" },
      };

      const message = buildEmailMessage(emailParams);

      // Verify headers are included even with templates
      assertExists(message.headers);
      assertExists(message.headers["X-Atlas-Version"]);
      assertExists(message.headers["X-Atlas-Hostname"]);

      // Verify template configuration is preserved
      assertEquals(message.templateId, "d-specific-template");
      assertExists(message.dynamicTemplateData);
    } finally {
      Deno.env.delete("SENDGRID_API_KEY");
    }
  });

  await t.step("headers are added to emails with attachments", () => {
    Deno.env.set("SENDGRID_API_KEY", "SG.test-key");

    try {
      const provider = new SendGridProvider("test", {
        enabled: true,
        apiKeyEnv: "SENDGRID_API_KEY",
        fromEmail: "test@example.com",
        sandboxMode: true,
      });

      const buildEmailMessage = provider.buildEmailMessage.bind(provider);

      const emailParams: EmailParams = {
        to: "recipient@example.com",
        subject: "Test Email",
        content: "Test content",
        attachments: [
          {
            filename: "test.txt",
            content: btoa("Test file content"),
            type: "text/plain",
            disposition: "attachment",
          },
        ],
      };

      const message = buildEmailMessage(emailParams);

      // Verify headers are included even with attachments
      assertExists(message.headers);
      assertExists(message.headers["X-Atlas-Version"]);
      assertExists(message.headers["X-Atlas-Hostname"]);

      // Verify attachments are preserved
      assertExists(message.attachments);
      assertEquals(message.attachments.length, 1);
    } finally {
      Deno.env.delete("SENDGRID_API_KEY");
    }
  });
});

// Integration test that verifies the complete flow
Deno.test({
  name: "SendGrid Custom Headers - Integration test with real email sending",
  ignore: !Deno.env.get("SENDGRID_API_KEY_TEST"), // Skip if no test API key
  async fn() {
    const mockPayload = {
      email: "integration.test@tempest.team",
      iss: "tempest-atlas",
      sub: "test-user",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    };
    const mockJWT = `header.${btoa(JSON.stringify(mockPayload))}.signature`;

    const originalKey = Deno.env.get("ATLAS_KEY");
    Deno.env.set("ATLAS_KEY", mockJWT);

    try {
      const provider = new SendGridProvider("test", {
        enabled: true,
        apiKeyEnv: "SENDGRID_API_KEY_TEST",
        fromEmail: "test@tempestdx.com",
        sandboxMode: true, // Always use sandbox for tests
      });

      const emailParams: EmailParams = {
        to: "test@tempestdx.com",
        subject: "Atlas Custom Headers Test",
        content: "This email should include custom Atlas tracking headers.",
      };

      const result = await provider.sendEmail(emailParams);

      // Verify email was sent successfully
      assertEquals(result.success, true);
      assertExists(result.message_id);

      // Note: We can't directly verify headers in the sent email from here,
      // but the test ensures the code path executes without errors
      // Headers can be verified manually in SendGrid dashboard
    } finally {
      if (originalKey) {
        Deno.env.set("ATLAS_KEY", originalKey);
      } else {
        Deno.env.delete("ATLAS_KEY");
      }
    }
  },
});
