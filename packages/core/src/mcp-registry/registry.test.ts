import { describe, expect, it } from "vitest";
import { mcpServersRegistry } from "./registry-consolidated.ts";

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
    expect(mcpServersRegistry.servers.stripe?.id).toEqual("stripe");
    expect(mcpServersRegistry.servers.azure?.id).toEqual("azure");
  });
});
