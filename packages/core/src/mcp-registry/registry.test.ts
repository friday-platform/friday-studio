import { describe, expect, it } from "vitest";
import { mcpServersRegistry } from "./registry-consolidated.ts";
import { MCPServerMetadataSchema } from "./schemas.ts";

describe("mcpServersRegistry", () => {
  it("has valid structure for all servers", () => {
    for (const [id, server] of Object.entries(mcpServersRegistry.servers)) {
      // Identity
      expect(server.id).toBeDefined();
      expect(server.id).toEqual(id);
      expect(server.name).toBeDefined();

      // Config
      expect(server.configTemplate).toBeDefined();
      expect(server.configTemplate.transport).toBeDefined();

      // Security
      expect(server.securityRating).toBeDefined();
      expect(server.source).toEqual("static");
    }
  });

  it("configTemplate uses placeholder format for credentials", () => {
    for (const [_id, server] of Object.entries(mcpServersRegistry.servers)) {
      if (server.configTemplate.env) {
        for (const [key, value] of Object.entries(server.configTemplate.env)) {
          // Only check values that look like they should be credentials
          if (
            key.includes("TOKEN") ||
            key.includes("KEY") ||
            key.includes("SECRET") ||
            key.includes("PASSWORD")
          ) {
            // Link credential refs are OK (not hardcoded)
            if (typeof value === "object" && value.from === "link") {
              continue;
            }

            // At this point, value must be a string due to the type guard above
            if (typeof value === "string") {
              // "auto" means credential is injected at runtime via Link
              const isPlaceholder =
                value.startsWith("your-") ||
                value.includes("${") ||
                value.includes("xxxx") ||
                value === "auto";
              expect(isPlaceholder).toBe(true);
            }
          }
        }
      }
    }
  });

  it("has correct metadata", () => {
    expect(mcpServersRegistry.metadata).toBeDefined();
    expect(mcpServersRegistry.metadata.version).toBeDefined();
    expect(mcpServersRegistry.metadata.lastUpdated).toBeDefined();
  });

  it("has requiredConfig for servers with env variables", () => {
    for (const [_id, server] of Object.entries(mcpServersRegistry.servers)) {
      const hasEnvVars =
        server.configTemplate.env && Object.keys(server.configTemplate.env).length > 0;

      if (hasEnvVars && server.configTemplate.env) {
        const hasCredentials = Object.keys(server.configTemplate.env).some(
          (key) =>
            key.includes("TOKEN") ||
            key.includes("KEY") ||
            key.includes("SECRET") ||
            key.includes("PASSWORD") ||
            key.includes("CLIENT"),
        );

        if (hasCredentials) {
          expect(server.requiredConfig).toBeDefined();
          expect(server.requiredConfig && server.requiredConfig.length > 0).toBe(true);
        }
      }
    }
  });

  it("has Record structure for O(1) lookup", () => {
    // Test that we can directly access servers by ID
    expect(mcpServersRegistry.servers.github?.id).toEqual("github");
    expect(mcpServersRegistry.servers.time?.id).toEqual("time");
  });

  describe("Google Workspace entries", () => {
    const googleIds = [
      "google-calendar",
      "google-gmail",
      "google-drive",
      "google-docs",
      "google-sheets",
    ];

    it.each(googleIds)("parses '%s' through MCPServerMetadataSchema", (id) => {
      const server = mcpServersRegistry.servers[id];
      expect(server).toBeDefined();
      const parsed = MCPServerMetadataSchema.safeParse(server);
      expect(parsed.success).toBe(true);
    });

    it.each(googleIds)("'%s' has startup config with command, args, and env", (id) => {
      const server = mcpServersRegistry.servers[id];
      if (!server) throw new Error(`missing server '${id}' in registry`);
      const startup = server.configTemplate.startup;
      expect(startup).toBeDefined();
      expect(startup!.type).toBe("command");
      expect(startup!.command).toBe("uvx");
      expect(startup!.args).toEqual(
        expect.arrayContaining(["workspace-mcp", "--tools", "--transport", "streamable-http"]),
      );
      expect(startup!.env).toBeDefined();
      expect(startup!.env).toHaveProperty("GOOGLE_OAUTH_CLIENT_ID");
      expect(startup!.env).toHaveProperty("GOOGLE_OAUTH_CLIENT_SECRET");
      expect(startup!.env).toHaveProperty("MCP_ENABLE_OAUTH21");
      expect(startup!.env).toHaveProperty("EXTERNAL_OAUTH21_PROVIDER");
      expect(startup!.env).toHaveProperty("WORKSPACE_MCP_PORT");
    });

    it.each(googleIds)("'%s' ready_url matches transport URL", (id) => {
      const server = mcpServersRegistry.servers[id];
      if (!server) throw new Error(`missing server '${id}' in registry`);
      const transportUrl =
        server.configTemplate.transport.type === "http" ? server.configTemplate.transport.url : "";
      expect(server.configTemplate.startup!.ready_url).toBe(transportUrl);
    });

    it.each(googleIds)("'%s' startup env uses plain strings or Link refs", (id) => {
      const server = mcpServersRegistry.servers[id];
      if (!server) throw new Error(`missing server '${id}' in registry`);
      const env = server.configTemplate.startup!.env!;
      for (const [_key, value] of Object.entries(env)) {
        const isValid =
          typeof value === "string" ||
          (typeof value === "object" && value !== null && "from" in value && value.from === "link");
        expect(isValid).toBe(true);
      }
    });
  });
});
