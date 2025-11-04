import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { mcpServersRegistry } from "./registry-consolidated.ts";

describe("mcpServersRegistry", () => {
  it("has valid structure for all servers", () => {
    for (const [id, server] of Object.entries(mcpServersRegistry.servers)) {
      // Identity
      assertExists(server.id, `Server ${id} missing id`);
      assertEquals(server.id, id, `Server ${id} has mismatched id`);
      assertExists(server.name, `Server ${id} missing name`);

      // Classification
      assertExists(server.category, `Server ${id} missing category`);
      assertExists(server.domains, `Server ${id} missing domains`);
      assertEquals(server.domains.length > 0, true, `Server ${id} has empty domains array`);

      // Config
      assertExists(server.configTemplate, `Server ${id} missing configTemplate`);
      assertExists(server.configTemplate.transport, `Server ${id} missing transport config`);

      // Security
      assertExists(server.securityRating, `Server ${id} missing securityRating`);
      assertEquals(server.source, "static", `Server ${id} has invalid source`);
    }
  });

  it("configTemplate uses placeholder format for credentials", () => {
    for (const [id, server] of Object.entries(mcpServersRegistry.servers)) {
      if (server.configTemplate.env) {
        for (const [key, value] of Object.entries(server.configTemplate.env)) {
          // Only check values that look like they should be credentials
          if (
            key.includes("TOKEN") ||
            key.includes("KEY") ||
            key.includes("SECRET") ||
            key.includes("PASSWORD")
          ) {
            const isPlaceholder =
              value.startsWith("your-") || value.includes("${") || value.includes("xxxx");
            assertEquals(
              isPlaceholder,
              true,
              `Server ${id} has hardcoded credential ${key}: ${value}`,
            );
          }
        }
      }
    }
  });

  it("has correct metadata", () => {
    assertExists(mcpServersRegistry.metadata);
    assertExists(mcpServersRegistry.metadata.version);
    assertExists(mcpServersRegistry.metadata.lastUpdated);
    assertEquals(
      mcpServersRegistry.metadata.totalServers,
      Object.keys(mcpServersRegistry.servers).length,
      "Metadata totalServers doesn't match actual server count",
    );
  });

  it("categories include all server categories", () => {
    const serverCategories = new Set(
      Object.values(mcpServersRegistry.servers).map((s) => s.category),
    );

    for (const category of serverCategories) {
      assertEquals(
        mcpServersRegistry.categories.includes(category),
        true,
        `Category ${category} used by servers but not in categories list`,
      );
    }
  });

  it("has requiredConfig for servers with env variables", () => {
    for (const [id, server] of Object.entries(mcpServersRegistry.servers)) {
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
          assertExists(server.requiredConfig, `Server ${id} has env vars but no requiredConfig`);
          assertEquals(
            server.requiredConfig?.length > 0,
            true,
            `Server ${id} has empty requiredConfig despite env vars`,
          );
        }
      }
    }
  });

  it("has Record structure for O(1) lookup", () => {
    // Test that we can directly access servers by ID
    assertEquals(mcpServersRegistry.servers["github-repos-manager"]?.id, "github-repos-manager");
    assertEquals(mcpServersRegistry.servers.stripe?.id, "stripe");
    assertEquals(mcpServersRegistry.servers.azure?.id, "azure");
  });
});
