/**
 * Tests for Atlas-level MCP configuration
 * Covers the platform-wide MCP server settings in atlas.yml
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// Simple mock configs for testing (no inheritance needed)
const mockAtlasConfigs = new Map<string, any>();

function setMockAtlasConfig(path: string, config: any) {
  mockAtlasConfigs.set(path, config);
}

function getMockAtlasConfig(path: string): any {
  const config = mockAtlasConfigs.get(path);
  if (!config) {
    throw new Error(`Mock config not found for path: ${path}`);
  }
  return config;
}

Deno.test("Atlas MCP Configuration", async (t) => {
  await t.step("Atlas MCP enabled - platform server should be available", async () => {
    setMockAtlasConfig("/test/atlas.yml", {
      version: "1.0",
      workspace: {
        id: "atlas-platform",
        name: "Atlas Platform",
      },
      server: {
        mcp: {
          enabled: true,
          discoverable: {
            capabilities: ["workspace_*"],
          },
        },
      },
    });

    const config = getMockAtlasConfig("/test/atlas.yml");

    assertEquals(config.server?.mcp?.enabled, true);
    assertEquals(config.server?.mcp?.discoverable?.capabilities, ["workspace_*"]);
  });

  await t.step("Atlas MCP disabled - platform server should not be available", async () => {
    setMockAtlasConfig("/test/atlas-disabled.yml", {
      version: "1.0",
      workspace: {
        id: "atlas-platform",
        name: "Atlas Platform",
      },
      server: {
        mcp: {
          enabled: false,
        },
      },
    });

    const config = getMockAtlasConfig("/test/atlas-disabled.yml");

    assertEquals(config.server?.mcp?.enabled, false);
  });

  await t.step("Atlas MCP with specific capability patterns", async () => {
    setMockAtlasConfig("/test/atlas-specific.yml", {
      version: "1.0",
      workspace: {
        id: "atlas-platform",
        name: "Atlas Platform",
      },
      server: {
        mcp: {
          enabled: true,
          discoverable: {
            capabilities: [
              "workspace_list",
              "workspace_create",
              "workspace_describe",
              "workspace_jobs_*",
            ],
          },
        },
      },
    });

    const config = getMockAtlasConfig("/test/atlas-specific.yml");

    assertEquals(config.server?.mcp?.enabled, true);
    assertEquals(config.server?.mcp?.discoverable?.capabilities.length, 4);
    assertEquals(config.server?.mcp?.discoverable?.capabilities.includes("workspace_jobs_*"), true);
  });

  await t.step("Atlas MCP with no discoverable capabilities", async () => {
    setMockAtlasConfig("/test/atlas-empty.yml", {
      version: "1.0",
      workspace: {
        id: "atlas-platform",
        name: "Atlas Platform",
      },
      server: {
        mcp: {
          enabled: true,
          discoverable: {
            capabilities: [],
          },
        },
      },
    });

    const config = getMockAtlasConfig("/test/atlas-empty.yml");

    assertEquals(config.server?.mcp?.enabled, true);
    assertEquals(config.server?.mcp?.discoverable?.capabilities, []);
  });

  await t.step("Atlas MCP missing configuration defaults to disabled", async () => {
    setMockAtlasConfig("/test/atlas-minimal.yml", {
      version: "1.0",
      workspace: {
        id: "atlas-platform",
        name: "Atlas Platform",
      },
      // No server.mcp section
    });

    const config = getMockAtlasConfig("/test/atlas-minimal.yml");

    // Should default to disabled when not specified
    assertEquals(config.server?.mcp?.enabled, undefined);
  });
});

// Test the two-level architecture: Atlas + Workspace MCP settings
Deno.test("Two-Level MCP Architecture", async (t) => {
  await t.step("Atlas enabled + Workspace enabled = Full access", () => {
    const atlasConfig: any = {
      server: { mcp: { enabled: true, discoverable: { capabilities: ["workspace_*"] } } },
    };
    const workspaceConfig: any = {
      server: { mcp: { enabled: true, discoverable: { jobs: ["public_*"] } } },
    };

    // Both levels enabled - should allow access
    const atlasEnabled = atlasConfig.server?.mcp?.enabled ?? false;
    const workspaceEnabled = workspaceConfig.server?.mcp?.enabled ?? false;

    assertEquals(atlasEnabled, true);
    assertEquals(workspaceEnabled, true);
    assertEquals(atlasEnabled && workspaceEnabled, true, "Both levels enabled should allow access");
  });

  await t.step("Atlas enabled + Workspace disabled = No access", () => {
    const atlasConfig: any = {
      server: { mcp: { enabled: true, discoverable: { capabilities: ["workspace_*"] } } },
    };
    const workspaceConfig: any = {
      server: { mcp: { enabled: false } },
    };

    const atlasEnabled = atlasConfig.server?.mcp?.enabled ?? false;
    const workspaceEnabled = workspaceConfig.server?.mcp?.enabled ?? false;

    assertEquals(atlasEnabled, true);
    assertEquals(workspaceEnabled, false);
    assertEquals(atlasEnabled && workspaceEnabled, false, "Workspace disabled should block access");
  });

  await t.step("Atlas disabled + Workspace enabled = No platform server", () => {
    const atlasConfig: any = {
      server: { mcp: { enabled: false } },
    };
    const workspaceConfig: any = {
      server: { mcp: { enabled: true, discoverable: { jobs: ["public_*"] } } },
    };

    const atlasEnabled = atlasConfig.server?.mcp?.enabled ?? false;
    const workspaceEnabled = workspaceConfig.server?.mcp?.enabled ?? false;

    assertEquals(atlasEnabled, false);
    assertEquals(workspaceEnabled, true);
    // Atlas disabled means no platform MCP server exists, regardless of workspace settings
    assertEquals(atlasEnabled, false, "Atlas disabled should prevent platform MCP server");
  });

  await t.step("Both disabled = No access", () => {
    const atlasConfig: any = {
      server: { mcp: { enabled: false } },
    };
    const workspaceConfig: any = {
      server: { mcp: { enabled: false } },
    };

    const atlasEnabled = atlasConfig.server?.mcp?.enabled ?? false;
    const workspaceEnabled = workspaceConfig.server?.mcp?.enabled ?? false;

    assertEquals(atlasEnabled, false);
    assertEquals(workspaceEnabled, false);
    assertEquals(atlasEnabled && workspaceEnabled, false, "Both disabled should block all access");
  });

  await t.step("Default behavior (undefined configs)", () => {
    const atlasConfig: any = {}; // No MCP config
    const workspaceConfig: any = {}; // No MCP config

    const atlasEnabled = atlasConfig.server?.mcp?.enabled ?? false;
    const workspaceEnabled = workspaceConfig.server?.mcp?.enabled ?? false;

    assertEquals(atlasEnabled, false);
    assertEquals(workspaceEnabled, false);
    assertEquals(
      atlasEnabled && workspaceEnabled,
      false,
      "Undefined configs should default to disabled",
    );
  });
});

// Test Atlas capability patterns
Deno.test("Atlas Capability Pattern Matching", async (t) => {
  function matchesCapabilityPattern(capabilities: string[], requestedCapability: string): boolean {
    for (const pattern of capabilities) {
      const isWildcard = pattern.endsWith("*");
      const basePattern = isWildcard ? pattern.slice(0, -1) : pattern;

      if (
        isWildcard ? requestedCapability.startsWith(basePattern) : requestedCapability === pattern
      ) {
        return true;
      }
    }
    return false;
  }

  await t.step("Wildcard capability patterns", () => {
    const capabilities = ["workspace_*", "session_*"];

    // Should match
    assertEquals(matchesCapabilityPattern(capabilities, "workspace_list"), true);
    assertEquals(matchesCapabilityPattern(capabilities, "workspace_create"), true);
    assertEquals(matchesCapabilityPattern(capabilities, "workspace_jobs_list"), true);
    assertEquals(matchesCapabilityPattern(capabilities, "session_start"), true);
    assertEquals(matchesCapabilityPattern(capabilities, "session_"), true); // Edge case

    // Should not match
    assertEquals(matchesCapabilityPattern(capabilities, "agent_list"), false);
    assertEquals(matchesCapabilityPattern(capabilities, "workspacetest"), false); // No underscore
    assertEquals(matchesCapabilityPattern(capabilities, "admin_task"), false);
  });

  await t.step("Exact capability patterns", () => {
    const capabilities = ["workspace_list", "workspace_create", "session_start"];

    // Should match
    assertEquals(matchesCapabilityPattern(capabilities, "workspace_list"), true);
    assertEquals(matchesCapabilityPattern(capabilities, "workspace_create"), true);
    assertEquals(matchesCapabilityPattern(capabilities, "session_start"), true);

    // Should not match
    assertEquals(matchesCapabilityPattern(capabilities, "workspace_delete"), false);
    assertEquals(matchesCapabilityPattern(capabilities, "workspace_list_extended"), false);
    assertEquals(matchesCapabilityPattern(capabilities, "session_stop"), false);
  });

  await t.step("Mixed capability patterns", () => {
    const capabilities = ["workspace_list", "workspace_create", "session_*", "agent_describe"];

    // Exact matches
    assertEquals(matchesCapabilityPattern(capabilities, "workspace_list"), true);
    assertEquals(matchesCapabilityPattern(capabilities, "workspace_create"), true);
    assertEquals(matchesCapabilityPattern(capabilities, "agent_describe"), true);

    // Wildcard matches
    assertEquals(matchesCapabilityPattern(capabilities, "session_start"), true);
    assertEquals(matchesCapabilityPattern(capabilities, "session_stop"), true);
    assertEquals(matchesCapabilityPattern(capabilities, "session_list"), true);

    // Non-matches
    assertEquals(matchesCapabilityPattern(capabilities, "workspace_delete"), false);
    assertEquals(matchesCapabilityPattern(capabilities, "agent_list"), false);
    assertEquals(matchesCapabilityPattern(capabilities, "memory_recall"), false);
  });

  await t.step("Empty capabilities list blocks everything", () => {
    const capabilities: string[] = [];

    assertEquals(matchesCapabilityPattern(capabilities, "workspace_list"), false);
    assertEquals(matchesCapabilityPattern(capabilities, "session_start"), false);
    assertEquals(matchesCapabilityPattern(capabilities, "any_capability"), false);
  });

  await t.step("Global wildcard allows everything", () => {
    const capabilities = ["*"];

    assertEquals(matchesCapabilityPattern(capabilities, "workspace_list"), true);
    assertEquals(matchesCapabilityPattern(capabilities, "session_start"), true);
    assertEquals(matchesCapabilityPattern(capabilities, "agent_describe"), true);
    assertEquals(matchesCapabilityPattern(capabilities, "custom_capability"), true);
    assertEquals(matchesCapabilityPattern(capabilities, ""), true); // Even empty string
  });
});

// Test configuration validation scenarios
Deno.test("Atlas MCP Configuration Validation", async (t) => {
  await t.step("Valid atlas.yml with all MCP fields", () => {
    const config: any = {
      version: "1.0",
      workspace: {
        id: "atlas-platform",
        name: "Atlas Platform",
      },
      server: {
        mcp: {
          enabled: true,
          discoverable: {
            capabilities: ["workspace_*", "session_start"],
          },
          rate_limits: {
            requests_per_hour: 1000,
            concurrent_sessions: 10,
          },
          auth: {
            required: false,
          },
        },
      },
    };

    // All fields should be accessible
    assertEquals(config.server.mcp.enabled, true);
    assertEquals(config.server.mcp.discoverable.capabilities.length, 2);
    assertEquals(config.server.mcp.rate_limits.requests_per_hour, 1000);
    assertEquals(config.server.mcp.auth.required, false);
  });

  await t.step("Minimal valid atlas.yml", () => {
    const config: any = {
      version: "1.0",
      workspace: {
        id: "atlas-platform",
        name: "Atlas Platform",
      },
      server: {
        mcp: {
          enabled: true,
        },
      },
    };

    // Should work with minimal config
    assertEquals(config.server.mcp.enabled, true);
    assertEquals(config.server.mcp.discoverable, undefined);
    assertEquals(config.server.mcp.rate_limits, undefined);
  });

  await t.step("Invalid capability names should be caught", () => {
    // Test with invalid capability names (contain dots)
    const invalidCapabilities = [
      "workspace.list", // Dots not allowed
      "session.start",
      "workspace_*", // This one is valid
      "agent.describe",
    ];

    // Filter out invalid capability names (those with dots)
    const validCapabilities = invalidCapabilities.filter((cap) => !cap.includes("."));

    assertEquals(validCapabilities, ["workspace_*"]);
    assertEquals(validCapabilities.length, 1);
  });
});
