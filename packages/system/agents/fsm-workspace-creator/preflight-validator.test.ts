/**
 * Pre-flight credential validation tests
 *
 * Tests the structured error format for missing credentials,
 * enabling LLM to call connect_service for error recovery.
 */

import type { CredentialBinding } from "@atlas/core/artifacts";
import { describe, expect, it } from "vitest";
import type { MCPServerResult } from "./enrichers/mcp-servers.ts";
import { formatMissingCredentialsError, validateCredentials } from "./preflight-validator.ts";

describe("validateCredentials", () => {
  it("returns valid=true when all credentials are bound", () => {
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

    expect(result.valid).toEqual(true);
    expect(result.missingCredentials).toEqual([]);
  });

  it("returns missing credentials with structured data", () => {
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

    expect(result.valid).toEqual(false);
    expect(result.missingCredentials.length).toEqual(1);
    expect(result.missingCredentials[0]?.provider).toEqual("google-calendar");
    expect(result.missingCredentials[0]?.service).toEqual("Google Calendar");
  });

  it("deduplicates missing credentials by provider", () => {
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

    expect(result.valid).toEqual(false);
    // Should only have one entry despite multiple env vars
    expect(result.missingCredentials.length).toEqual(1);
    expect(result.missingCredentials[0]?.provider).toEqual("google-calendar");
  });

  it("collects multiple missing providers", () => {
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
          env: { GH_TOKEN: { from: "link", provider: "github", key: "access_token" } },
        },
      },
    ];

    const result = validateCredentials(mcpServers, []);

    expect(result.valid).toEqual(false);
    expect(result.missingCredentials.length).toEqual(2);

    const providers = result.missingCredentials.map((c) => c.provider);
    expect(providers.includes("google-calendar")).toEqual(true);
    expect(providers.includes("github")).toEqual(true);
  });
});

describe("formatMissingCredentialsError", () => {
  it("formats error message with provider info", () => {
    const result = formatMissingCredentialsError([
      { provider: "google-calendar", service: "Google Calendar" },
      { provider: "github", service: "GitHub" },
    ]);
    expect(result).toContain("Missing integrations:");
    expect(result).toContain("• Google Calendar [provider: google-calendar]");
    expect(result).toContain("• GitHub [provider: github]");
  });
});
