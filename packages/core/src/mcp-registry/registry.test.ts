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

  describe("filesystem entry", () => {
    it("parses through MCPServerMetadataSchema", () => {
      const server = mcpServersRegistry.servers.filesystem;
      expect(server).toBeDefined();
      const parsed = MCPServerMetadataSchema.safeParse(server);
      expect(parsed.success).toBe(true);
    });

    it("uses npx stdio transport scoped to ${HOME}", () => {
      const server = mcpServersRegistry.servers.filesystem;
      if (!server) throw new Error("missing filesystem server in registry");
      expect(server.configTemplate.transport.type).toBe("stdio");
      if (server.configTemplate.transport.type !== "stdio") return;
      expect(server.configTemplate.transport.command).toBe("npx");
      expect(server.configTemplate.transport.args).toEqual([
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "${HOME}",
      ]);
    });

    it("exposes the full tool surface (no allow/deny filter)", () => {
      const server = mcpServersRegistry.servers.filesystem;
      if (!server) throw new Error("missing filesystem server in registry");
      expect(server.configTemplate.tools).toBeUndefined();
    });
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
        expect.arrayContaining(["workspace-mcp", "--transport", "streamable-http"]),
      );
      // Either tool-set filtering (--tools) or permission-level filtering
      // (--permissions) — these flags are mutually exclusive in workspace-mcp.
      const hasToolsFlag = startup!.args!.includes("--tools");
      const hasPermissionsFlag = startup!.args!.includes("--permissions");
      expect(hasToolsFlag || hasPermissionsFlag).toBe(true);
      expect(hasToolsFlag && hasPermissionsFlag).toBe(false);
      expect(startup!.env).toBeDefined();
      // Per-server config only — OAuth vars live in platformEnv
      expect(startup!.env).toHaveProperty("WORKSPACE_MCP_PORT");
      expect(startup!.env).not.toHaveProperty("GOOGLE_OAUTH_CLIENT_ID");
      expect(startup!.env).not.toHaveProperty("GOOGLE_OAUTH_CLIENT_SECRET");
      expect(startup!.env).not.toHaveProperty("MCP_ENABLE_OAUTH21");
      expect(startup!.env).not.toHaveProperty("EXTERNAL_OAUTH21_PROVIDER");
    });

    it.each(
      googleIds,
    )("'%s' has platformEnv with OAuth flags, stateless mode, and dummy client_id/secret", (id) => {
      const server = mcpServersRegistry.servers[id];
      if (!server) throw new Error(`missing server '${id}' in registry`);
      expect(server.platformEnv).toBeDefined();
      // workspace-mcp requires GOOGLE_OAUTH_CLIENT_ID and _SECRET to be
      // *present* even in EXTERNAL_OAUTH21_PROVIDER mode (see the wall-of-text
      // comment in registry-consolidated.ts).  The values are dummies — real
      // tokens arrive via HTTP Bearer headers resolved by Link.
      expect(server.platformEnv).toHaveProperty("GOOGLE_OAUTH_CLIENT_ID", "external");
      expect(server.platformEnv).toHaveProperty("GOOGLE_OAUTH_CLIENT_SECRET", "external");
      expect(server.platformEnv).toHaveProperty("MCP_ENABLE_OAUTH21", "true");
      expect(server.platformEnv).toHaveProperty("EXTERNAL_OAUTH21_PROVIDER", "true");
      expect(server.platformEnv).toHaveProperty("WORKSPACE_MCP_STATELESS_MODE", "true");
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
