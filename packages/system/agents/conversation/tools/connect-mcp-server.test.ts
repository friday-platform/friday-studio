// Import from registry directly (no circular dep)
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import { describe, expect, it } from "vitest";

// Import pure utils directly (no circular dep)
import { CONFIG_TEMPLATES, checkBlessedRegistry } from "./connect-mcp-server-utils.ts";

/**
 * Unit tests for deterministic code paths in connect-mcp-server.ts
 *
 * Tests cover:
 * - checkBlessedRegistry: URL matching, word matching, false positive prevention
 * - toBlessedMatch: auth type inference (tested via checkBlessedRegistry)
 * - CONFIG_TEMPLATES: structural validation of all 5 templates
 * - toEnvKey: env var name transformation (tested via CONFIG_TEMPLATES)
 */

describe("connect-mcp-server", () => {
  describe("checkBlessedRegistry", () => {
    // Helper to call checkBlessedRegistry with the global registry
    const check = (input: string) => checkBlessedRegistry(input, mcpServersRegistry.servers);

    describe("URL matching (highest confidence)", () => {
      it("matches Linear by exact URL", () => {
        const match = check("https://mcp.linear.app/mcp");
        expect(match).toBeDefined();
        if (!match) throw new Error("Expected match to be defined");
        expect(match.id).toEqual("linear");
        expect(match.authType).toEqual("oauth");
      });

      it("matches GitHub by URL embedded in text", () => {
        const match = check("Connect to https://api.githubcopilot.com/mcp for GitHub");
        expect(match).toBeDefined();
        if (!match) throw new Error("Expected match to be defined");
        expect(match.id).toEqual("github");
        expect(match.authType).toEqual("oauth");
      });

      it("matches Notion by URL", () => {
        const match = check("https://mcp.notion.com/mcp");
        expect(match).toBeDefined();
        if (!match) throw new Error("Expected match to be defined");
        expect(match.id).toEqual("notion");
        expect(match.authType).toEqual("oauth");
      });
    });

    describe("non-URL input returns null (falls through to LLM)", () => {
      it("does not match service names as words", () => {
        expect(check("I want to add the Linear MCP server")).toEqual(null);
        expect(check("connect github")).toEqual(null);
        expect(check("add google-calendar")).toEqual(null);
      });

      it("does not match unknown service URLs", () => {
        expect(check("https://mcp.acme-internal.com/api")).toEqual(null);
      });

      it("does not match partial IDs or common words", () => {
        expect(check("I need to linearize this data structure")).toEqual(null);
        expect(check("track time for my linear workflow progression")).toEqual(null);
      });
    });
  });

  describe("CONFIG_TEMPLATES", () => {
    const testValues = {
      id: "test-service",
      name: "Test Service",
      description: "A test service",
      domains: ["test", "demo"],
      url: "https://api.test.com/mcp",
      command: "npx",
      args: ["-y", "@test/mcp-server"],
      tokenEnvVar: "TEST_API_KEY",
    };

    it("has all 5 expected templates", () => {
      const templateKeys = Object.keys(CONFIG_TEMPLATES);
      expect(templateKeys).toHaveLength(5);
      expect(templateKeys).toContain("http-oauth");
      expect(templateKeys).toContain("http-apikey");
      expect(templateKeys).toContain("http-none");
      expect(templateKeys).toContain("stdio-apikey");
      expect(templateKeys).toContain("stdio-none");
    });

    describe("http-oauth template", () => {
      it("produces valid structure with OAuth provider", () => {
        const result = CONFIG_TEMPLATES["http-oauth"](testValues);

        // Registry structure
        expect(result.registry.id).toEqual("test-service");
        expect(result.registry.name).toEqual("Test Service");
        // Domains should include the server ID for reliable matching
        expect(result.registry.domains.sort()).toEqual(["demo", "test", "test-service"]);
        expect(result.registry.configTemplate.transport).toMatchObject({
          type: "http",
          url: "https://api.test.com/mcp",
        });
        expect(result.registry.configTemplate.auth?.type).toEqual("bearer");
        expect(result.registry.configTemplate.env).toBeDefined();
        expect(result.registry.requiredConfig).toBeDefined();

        // Provider structure - narrow via discriminated union
        expect(result.provider).not.toBeNull();
        expect(result.provider?.type).toEqual("oauth");
        expect(result.provider?.id).toEqual("test-service");
        if (result.provider?.type === "oauth") {
          expect(result.provider.oauthConfig.mode).toEqual("discovery");
        }
      });

      it("generates correct env key (toEnvKey)", () => {
        const result = CONFIG_TEMPLATES["http-oauth"](testValues);
        const envKey = "TEST_SERVICE_ACCESS_TOKEN";
        expect(result.registry.configTemplate.env?.[envKey]).toBeDefined();
        expect(result.registry.configTemplate.auth?.token_env).toEqual(envKey);
      });
    });

    describe("http-apikey template", () => {
      it("produces valid structure with API key provider", () => {
        const result = CONFIG_TEMPLATES["http-apikey"](testValues);

        expect(result.registry.configTemplate.transport.type).toEqual("http");
        expect(result.registry.configTemplate.auth?.type).toEqual("bearer");

        expect(result.provider).not.toBeNull();
        expect(result.provider?.type).toEqual("apikey");
        if (result.provider?.type === "apikey") {
          expect(result.provider.secretSchema.api_key).toEqual("string");
        }
      });

      it("uses provided tokenEnvVar when specified", () => {
        const result = CONFIG_TEMPLATES["http-apikey"](testValues);
        expect(result.registry.configTemplate.auth?.token_env).toEqual("TEST_API_KEY");
      });

      it("generates default env key when tokenEnvVar not provided", () => {
        const valuesWithoutToken = { ...testValues, tokenEnvVar: undefined };
        const result = CONFIG_TEMPLATES["http-apikey"](valuesWithoutToken);
        expect(result.registry.configTemplate.auth?.token_env).toEqual("TEST_SERVICE_API_KEY");
      });

      it("includes env with link reference for api_key", () => {
        const result = CONFIG_TEMPLATES["http-apikey"](testValues);
        const env = result.registry.configTemplate.env;
        expect(env).toBeDefined();
        expect(env?.TEST_API_KEY).toEqual({
          from: "link",
          provider: "test-service",
          key: "api_key",
        });
      });
    });

    describe("http-none template", () => {
      it("produces valid structure with no auth", () => {
        const result = CONFIG_TEMPLATES["http-none"](testValues);

        expect(result.registry.configTemplate.transport.type).toEqual("http");
        expect(result.registry.configTemplate.auth).toBeUndefined();
        expect(result.provider).toBeNull();
      });
    });

    describe("stdio-apikey template", () => {
      it("produces valid structure with command and API key", () => {
        const result = CONFIG_TEMPLATES["stdio-apikey"](testValues);

        expect(result.registry.configTemplate.transport).toMatchObject({
          type: "stdio",
          command: "npx",
          args: ["-y", "@test/mcp-server"],
        });

        expect(result.provider).not.toBeNull();
        expect(result.provider?.type).toEqual("apikey");
      });

      it("includes env with link reference", () => {
        const result = CONFIG_TEMPLATES["stdio-apikey"](testValues);
        const env = result.registry.configTemplate.env;
        expect(env).toBeDefined();
        expect(env?.TEST_API_KEY).toEqual({
          from: "link",
          provider: "test-service",
          key: "api_key",
        });
      });
    });

    describe("stdio-none template", () => {
      it("produces valid structure with command and no auth", () => {
        const result = CONFIG_TEMPLATES["stdio-none"](testValues);

        expect(result.registry.configTemplate.transport).toMatchObject({
          type: "stdio",
          command: "npx",
          args: ["-y", "@test/mcp-server"],
        });
        expect(result.provider).toBeNull();
      });
    });
  });

  describe("toEnvKey (via CONFIG_TEMPLATES)", () => {
    it("converts kebab-case to SCREAMING_SNAKE_CASE", () => {
      const result = CONFIG_TEMPLATES["http-oauth"]({
        id: "google-calendar",
        name: "Google Calendar",
        description: "Calendar",
        domains: ["calendar"],
        url: "https://cal.example.com/mcp",
      });
      expect(result.registry.configTemplate.auth?.token_env).toEqual(
        "GOOGLE_CALENDAR_ACCESS_TOKEN",
      );
    });

    it("handles single-word IDs", () => {
      const result = CONFIG_TEMPLATES["http-oauth"]({
        id: "linear",
        name: "Linear",
        description: "Linear",
        domains: ["linear"],
        url: "https://linear.example.com/mcp",
      });
      expect(result.registry.configTemplate.auth?.token_env).toEqual("LINEAR_ACCESS_TOKEN");
    });

    it("handles multiple hyphens", () => {
      const result = CONFIG_TEMPLATES["http-oauth"]({
        id: "google-gen-ai",
        name: "Google Gen AI",
        description: "AI",
        domains: ["ai"],
        url: "https://ai.example.com/mcp",
      });
      expect(result.registry.configTemplate.auth?.token_env).toEqual("GOOGLE_GEN_AI_ACCESS_TOKEN");
    });
  });

  describe("requireUrl / requireCommand error paths", () => {
    it("http-oauth throws when URL is missing", () => {
      expect(() =>
        CONFIG_TEMPLATES["http-oauth"]({
          id: "no-url",
          name: "No URL",
          description: "Missing URL",
          domains: ["test"],
        }),
      ).toThrow("HTTP template requires URL");
    });

    it("http-apikey throws when URL is missing", () => {
      expect(() =>
        CONFIG_TEMPLATES["http-apikey"]({
          id: "no-url",
          name: "No URL",
          description: "Missing URL",
          domains: ["test"],
        }),
      ).toThrow("HTTP template requires URL");
    });

    it("http-none throws when URL is missing", () => {
      expect(() =>
        CONFIG_TEMPLATES["http-none"]({
          id: "no-url",
          name: "No URL",
          description: "Missing URL",
          domains: ["test"],
        }),
      ).toThrow("HTTP template requires URL");
    });

    it("stdio-apikey throws when command is missing", () => {
      expect(() =>
        CONFIG_TEMPLATES["stdio-apikey"]({
          id: "no-cmd",
          name: "No Command",
          description: "Missing command",
          domains: ["test"],
        }),
      ).toThrow("stdio template requires command");
    });

    it("stdio-none throws when command is missing", () => {
      expect(() =>
        CONFIG_TEMPLATES["stdio-none"]({
          id: "no-cmd",
          name: "No Command",
          description: "Missing command",
          domains: ["test"],
        }),
      ).toThrow("stdio template requires command");
    });
  });
});
