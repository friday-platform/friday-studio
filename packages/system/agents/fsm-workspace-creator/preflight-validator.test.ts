/**
 * Pre-flight credential validation tests
 *
 * Tests the structured error format for missing credentials,
 * enabling LLM to call connect_service for error recovery.
 */

import type { CredentialBinding } from "@atlas/core/artifacts";
import { assertEquals } from "@std/assert";
import type { MCPServerResult } from "./enrichers/mcp-servers.ts";
import { formatMissingCredentialsError, validateCredentials } from "./preflight-validator.ts";

Deno.test("validateCredentials", async (t) => {
  await t.step("returns valid=true when all credentials are bound", () => {
    // Simulate MCP servers that need Link credentials
    const mcpServers: MCPServerResult[] = [
      {
        id: "google-calendar",
        config: {
          transport: { type: "http", url: "https://example.com" },
          env: {
            GOOGLE_CALENDAR_ACCESS_TOKEN: {
              from: "link",
              provider: "google-calendar",
              key: "access_token",
            },
          },
        },
      },
    ];

    const credentials: CredentialBinding[] = [
      {
        targetType: "mcp",
        serverId: "google-calendar",
        field: "GOOGLE_CALENDAR_ACCESS_TOKEN",
        credentialId: "cred_123",
        provider: "google-calendar",
        key: "access_token",
      },
    ];

    const result = validateCredentials(mcpServers, credentials);

    assertEquals(result.valid, true);
    assertEquals(result.missingCredentials, []);
  });

  await t.step("returns missing credentials with structured data", () => {
    // Simulate MCP server that needs Link credentials
    const mcpServers: MCPServerResult[] = [
      {
        id: "google-calendar",
        config: {
          transport: { type: "http", url: "https://example.com" },
          env: {
            GOOGLE_CALENDAR_ACCESS_TOKEN: {
              from: "link",
              provider: "google-calendar",
              key: "access_token",
            },
          },
        },
      },
    ];

    // No credentials bound
    const result = validateCredentials(mcpServers, []);

    assertEquals(result.valid, false);
    assertEquals(result.missingCredentials.length, 1);
    assertEquals(result.missingCredentials[0]?.provider, "google-calendar");
    assertEquals(result.missingCredentials[0]?.service, "Google Calendar");
  });

  await t.step("deduplicates missing credentials by provider", () => {
    // Simulate MCP server that needs multiple env vars from same provider
    const mcpServers: MCPServerResult[] = [
      {
        id: "google-calendar",
        config: {
          transport: { type: "http", url: "https://example.com" },
          env: {
            GOOGLE_CALENDAR_ACCESS_TOKEN: {
              from: "link",
              provider: "google-calendar",
              key: "access_token",
            },
            GOOGLE_CALENDAR_REFRESH_TOKEN: {
              from: "link",
              provider: "google-calendar",
              key: "refresh_token",
            },
          },
        },
      },
    ];

    const result = validateCredentials(mcpServers, []);

    assertEquals(result.valid, false);
    // Should only have one entry despite multiple env vars
    assertEquals(result.missingCredentials.length, 1);
    assertEquals(result.missingCredentials[0]?.provider, "google-calendar");
  });

  await t.step("collects multiple missing providers", () => {
    const mcpServers: MCPServerResult[] = [
      {
        id: "google-calendar",
        config: {
          transport: { type: "http", url: "https://example.com" },
          env: {
            GOOGLE_CALENDAR_ACCESS_TOKEN: {
              from: "link",
              provider: "google-calendar",
              key: "access_token",
            },
          },
        },
      },
      {
        id: "github",
        config: {
          transport: { type: "http", url: "https://example.com" },
          env: { GH_CLASSIC_PAT: { from: "link", provider: "github", key: "access_token" } },
        },
      },
    ];

    const result = validateCredentials(mcpServers, []);

    assertEquals(result.valid, false);
    assertEquals(result.missingCredentials.length, 2);

    const providers = result.missingCredentials.map((c) => c.provider);
    assertEquals(providers.includes("google-calendar"), true);
    assertEquals(providers.includes("github"), true);
  });

  await t.step("skips servers without env config", () => {
    const mcpServers: MCPServerResult[] = [
      {
        id: "some-server",
        config: {
          transport: { type: "http", url: "https://example.com" },
          // No env config
        },
      },
    ];

    const result = validateCredentials(mcpServers, []);

    assertEquals(result.valid, true);
    assertEquals(result.missingCredentials, []);
  });

  await t.step("skips env vars without from=link", () => {
    const mcpServers: MCPServerResult[] = [
      {
        id: "some-server",
        config: {
          transport: { type: "http", url: "https://example.com" },
          env: { STATIC_VAR: "static-value" },
        },
      },
    ];

    const result = validateCredentials(mcpServers, []);

    assertEquals(result.valid, true);
    assertEquals(result.missingCredentials, []);
  });
});

Deno.test("formatMissingCredentialsError", async (t) => {
  await t.step("formats single missing credential", () => {
    const missingCredentials = [{ provider: "google-calendar", service: "Google Calendar" }];

    const message = formatMissingCredentialsError(missingCredentials);

    assertEquals(message.includes("Google Calendar [provider: google-calendar]"), true);
    assertEquals(message.includes("Missing integrations"), true);
    assertEquals(message.includes("Connect these services"), true);
  });

  await t.step("formats multiple missing credentials", () => {
    const missingCredentials = [
      { provider: "google-calendar", service: "Google Calendar" },
      { provider: "github", service: "GitHub" },
    ];

    const message = formatMissingCredentialsError(missingCredentials);

    assertEquals(message.includes("Google Calendar [provider: google-calendar]"), true);
    assertEquals(message.includes("GitHub [provider: github]"), true);
  });
});
